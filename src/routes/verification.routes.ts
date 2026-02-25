import { Router } from "express";
import { db } from "../db";
import { auth, AuthedRequest } from "../middleware/auth";
import { requireRole } from "../middleware/role";

const router = Router();

function getClientIp(req: any): string | null {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) return xf.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

async function audit(params: {
  user_id: number;
  action: string;
  entity?: string | null;
  entity_id?: number | null;
  ip_addr?: string | null;
}) {
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, ip_addr)
       VALUES (?, ?, ?, ?, ?)`,
      [params.user_id, params.action, params.entity ?? null, params.entity_id ?? null, params.ip_addr ?? null]
    );
  } catch {}
}

async function getDosenIdByUserId(userId: number): Promise<number | null> {
  const [rows] = await db.query<any[]>(
    `SELECT id_dosen FROM dosen WHERE user_id = ? LIMIT 1`,
    [userId]
  );
  return rows?.[0]?.id_dosen ?? null;
}

function normalizeStatus(s: any): "wajar" | "perlu_revisi" | "plagiarisme" | null {
  if (!s) return null;
  const v = String(s).trim().toLowerCase();
  if (v === "wajar") return "wajar";
  if (v === "perlu_revisi" || v === "perlu revisi") return "perlu_revisi";
  if (v === "plagiarisme") return "plagiarisme";
  return null;
}

/**
 * POST /api/verification/:resultId
 * body: { status: 'wajar'|'perlu_revisi'|'plagiarisme', note_text?: string }
 *
 * Behavior:
 * - kalau sudah ada note untuk resultId, kita UPDATE (biar dosen bisa revisi penilaian)
 * - kalau belum ada, INSERT
 */
router.post("/:resultId", auth, requireRole("dosen"), async (req: AuthedRequest, res) => {
  const ip = getClientIp(req);
  const resultId = Number(req.params.resultId);

  if (!Number.isFinite(resultId) || resultId <= 0) {
    return res.status(400).json({ ok: false, message: "Invalid resultId" });
  }

  const status = normalizeStatus(req.body?.status);
  const noteText = req.body?.note_text !== undefined ? String(req.body.note_text) : "";

  if (!status) {
    return res.status(400).json({ ok: false, message: "Invalid status. Use: wajar | perlu_revisi | plagiarisme" });
  }

  try {
    const dosenId = await getDosenIdByUserId(req.user!.id);
    if (!dosenId) return res.status(403).json({ ok: false, message: "Dosen profile not found for this user" });

    // pastikan result ada
    const [rRows] = await db.query<any[]>(
      `SELECT id_result, check_id, similarity, created_at FROM check_result WHERE id_result = ? LIMIT 1`,
      [resultId]
    );
    const result = rRows[0];
    if (!result) return res.status(404).json({ ok: false, message: "Result not found" });

    // cek apakah sudah ada note
    const [nRows] = await db.query<any[]>(
      `SELECT id_note FROM verification_note WHERE result_id = ? LIMIT 1`,
      [resultId]
    );
    const existing = nRows[0];

    if (existing) {
      await db.query(
        `UPDATE verification_note
         SET verifier_id = ?, status = ?, note_text = ?
         WHERE result_id = ?`,
        [dosenId, status, noteText, resultId]
      );

      await audit({
        user_id: req.user!.id,
        action: "DOSEN_UPDATE_VERIFICATION_NOTE",
        entity: "verification_note",
        entity_id: existing.id_note,
        ip_addr: ip,
      });
    } else {
      const [ins] = await db.query<any>(
        `INSERT INTO verification_note (result_id, verifier_id, status, note_text, created_at)
         VALUES (?, ?, ?, ?, NOW())`,
        [resultId, dosenId, status, noteText]
      );

      await audit({
        user_id: req.user!.id,
        action: "DOSEN_CREATE_VERIFICATION_NOTE",
        entity: "verification_note",
        entity_id: ins.insertId ?? null,
        ip_addr: ip,
      });
    }

    const [outRows] = await db.query<any[]>(
      `
      SELECT
        vn.id_note, vn.result_id, vn.verifier_id, vn.status, vn.note_text, vn.created_at,
        d.nama AS dosen_nama, d.nidn AS dosen_nidn
      FROM verification_note vn
      JOIN dosen d ON d.id_dosen = vn.verifier_id
      WHERE vn.result_id = ?
      LIMIT 1
      `,
      [resultId]
    );

    return res.status(201).json({ ok: true, verification: outRows[0] });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

/**
 * GET /api/verification/pending
 * List hasil check_result yang belum punya verification_note
 *
 * query:
 * - limit, offset
 * - min_similarity (optional) ex: 10 -> tampilkan hanya yang >=10%
 */
router.get("/pending", auth, requireRole("dosen"), async (req: AuthedRequest, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const minSimilarity = req.query.min_similarity !== undefined ? Number(req.query.min_similarity) : null;

    const where: string[] = ["vn.id_note IS NULL"];
    const params: any[] = [];

    if (minSimilarity !== null && Number.isFinite(minSimilarity)) {
      where.push("cr2.similarity >= ?");
      params.push(minSimilarity);
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [rows] = await db.query<any[]>(
      `
      SELECT
        cr2.id_result,
        cr2.similarity,
        cr2.created_at AS result_created_at,
        cr.id_check,
        cr.doc_id,
        cr.requested_by,
        u.name AS requester_name,
        u.email AS requester_email,
        ud.title AS doc_title,
        cr.finished_at
      FROM check_result cr2
      JOIN check_request cr ON cr.id_check = cr2.check_id
      JOIN users u ON u.id = cr.requested_by
      JOIN user_document ud ON ud.id_doc = cr.doc_id
      LEFT JOIN verification_note vn ON vn.result_id = cr2.id_result
      ${whereSql}
      ORDER BY cr2.id_result DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    const [countRows] = await db.query<any[]>(
      `
      SELECT COUNT(*) AS total
      FROM check_result cr2
      LEFT JOIN verification_note vn ON vn.result_id = cr2.id_result
      JOIN check_request cr ON cr.id_check = cr2.check_id
      ${whereSql}
      `,
      params
    );

    return res.json({
      ok: true,
      total: countRows?.[0]?.total ?? 0,
      limit,
      offset,
      rows,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

/**
 * GET /api/verification/results
 * List semua check_result untuk dosen (pending + sudah ada note)
 *
 * query:
 * - limit, offset
 * - min_similarity (optional)
 * - status (optional) -> filter status note: wajar|perlu_revisi|plagiarisme
 * - only_pending (optional) -> 1 untuk hanya pending (mirip /pending)
 */
router.get("/results", auth, requireRole("dosen"), async (req: AuthedRequest, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    const minSimilarity = req.query.min_similarity !== undefined ? Number(req.query.min_similarity) : null;
    const onlyPending = String(req.query.only_pending ?? "0") === "1";
    const statusFilter = req.query.status ? normalizeStatus(req.query.status) : null;

    const where: string[] = [];
    const params: any[] = [];

    if (onlyPending) where.push("vn.id_note IS NULL");

    if (minSimilarity !== null && Number.isFinite(minSimilarity)) {
      where.push("cr2.similarity >= ?");
      params.push(minSimilarity);
    }

    if (statusFilter) {
      where.push("vn.status = ?");
      params.push(statusFilter);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await db.query<any[]>(
      `
      SELECT
        cr2.id_result,
        cr2.similarity,
        cr2.created_at AS result_created_at,

        cr.id_check,
        cr.doc_id,
        cr.requested_by,
        u.name AS requester_name,
        u.email AS requester_email,
        ud.title AS doc_title,
        cr.finished_at,

        vn.id_note,
        vn.status AS verification_status,
        vn.note_text,
        vn.created_at AS note_created_at,
        d.nama AS verifier_name,
        d.nidn AS verifier_nidn
      FROM check_result cr2
      JOIN check_request cr ON cr.id_check = cr2.check_id
      JOIN users u ON u.id = cr.requested_by
      JOIN user_document ud ON ud.id_doc = cr.doc_id
      LEFT JOIN verification_note vn ON vn.result_id = cr2.id_result
      LEFT JOIN dosen d ON d.id_dosen = vn.verifier_id
      ${whereSql}
      ORDER BY cr2.id_result DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    const [countRows] = await db.query<any[]>(
      `
      SELECT COUNT(*) AS total
      FROM check_result cr2
      JOIN check_request cr ON cr.id_check = cr2.check_id
      JOIN users u ON u.id = cr.requested_by
      JOIN user_document ud ON ud.id_doc = cr.doc_id
      LEFT JOIN verification_note vn ON vn.result_id = cr2.id_result
      LEFT JOIN dosen d ON d.id_dosen = vn.verifier_id
      ${whereSql}
      `,
      params
    );

    return res.json({
      ok: true,
      total: countRows?.[0]?.total ?? 0,
      limit,
      offset,
      rows,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

/**
 * GET /api/verification/:resultId
 * lihat note untuk result tertentu
 */
router.get("/:resultId", auth, requireRole("dosen"), async (req: AuthedRequest, res) => {
  const resultId = Number(req.params.resultId);
  if (!Number.isFinite(resultId) || resultId <= 0) {
    return res.status(400).json({ ok: false, message: "Invalid resultId" });
  }

  try {
    const [rows] = await db.query<any[]>(
      `
      SELECT
        vn.id_note, vn.result_id, vn.verifier_id, vn.status, vn.note_text, vn.created_at,
        d.nama AS dosen_nama, d.nidn AS dosen_nidn
      FROM verification_note vn
      JOIN dosen d ON d.id_dosen = vn.verifier_id
      WHERE vn.result_id = ?
      LIMIT 1
      `,
      [resultId]
    );

    if (!rows[0]) return res.status(404).json({ ok: false, message: "Verification note not found" });
    return res.json({ ok: true, verification: rows[0] });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});



export default router;