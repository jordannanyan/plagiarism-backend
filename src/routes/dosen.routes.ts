import { Router } from "express";
import fs from "fs";
import { db } from "../db";
import { auth, AuthedRequest } from "../middleware/auth";
import { requireRole } from "../middleware/role";
import { stripUncheckableSections } from "../utils/textExtract";

const router = Router();

async function getDosenIdByUserId(userId: number): Promise<number | null> {
  const [rows] = await db.query<any[]>(
    `SELECT id_dosen FROM dosen WHERE user_id = ? LIMIT 1`,
    [userId]
  );
  return rows?.[0]?.id_dosen ?? null;
}

function readTextSafe(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Baca flag exclude_metadata dari summary_json. Default true (record lama).
 */
function readExcludeMetadata(summaryJson: any): boolean {
  try {
    const obj = typeof summaryJson === "string" ? JSON.parse(summaryJson) : summaryJson;
    if (obj && typeof obj.exclude_metadata === "boolean") return obj.exclude_metadata;
  } catch {}
  return true;
}

/**
 * Cek apakah dosen punya akses ke resultId (lewat check_target_dosen).
 * Backward-compat: kalau check tidak punya target sama sekali (legacy),
 * semua dosen boleh akses.
 */
async function ensureDosenTargetedForResult(
  resultId: number,
  dosenId: number
): Promise<{ ok: true; checkId: number } | { ok: false; reason: "not_found" | "forbidden" }> {
  const [rows] = await db.query<any[]>(
    `SELECT cr.id_check
     FROM check_result cr2
     JOIN check_request cr ON cr.id_check = cr2.check_id
     WHERE cr2.id_result = ?
     LIMIT 1`,
    [resultId]
  );
  const checkId = rows?.[0]?.id_check;
  if (!checkId) return { ok: false, reason: "not_found" };

  const [tRows] = await db.query<any[]>(
    `SELECT
       (SELECT COUNT(*) FROM check_target_dosen WHERE id_check = ?) AS total_targets,
       (SELECT COUNT(*) FROM check_target_dosen WHERE id_check = ? AND id_dosen = ?) AS is_target`,
    [checkId, checkId, dosenId]
  );
  const totalTargets = Number(tRows?.[0]?.total_targets ?? 0);
  const isTarget = Number(tRows?.[0]?.is_target ?? 0) > 0;

  if (totalTargets === 0 || isTarget) return { ok: true, checkId };
  return { ok: false, reason: "forbidden" };
}

/**
 * GET /api/dosen/list
 * Dipakai mahasiswa untuk multi-select tujuan dosen waktu create check.
 */
router.get("/list", auth, requireRole("mahasiswa", "dosen", "admin"), async (_req: AuthedRequest, res) => {
  try {
    const [rows] = await db.query<any[]>(
      `
      SELECT d.id_dosen, d.nama, d.nidn, u.email
      FROM dosen d
      JOIN users u ON u.id = d.user_id
      WHERE u.is_active = 1
      ORDER BY d.nama ASC
      `
    );
    return res.json({ ok: true, rows });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

/**
 * GET /api/dosen/docs/pending
 * Dokumen yang ditargetkan ke dosen ini DAN belum diverifikasi.
 *
 * Backward-compat: check_request yang tidak punya entry di check_target_dosen
 * (legacy) tetap muncul untuk semua dosen.
 *
 * Query:
 *  - q (optional) -> cari di nama mahasiswa, NIM, atau judul dokumen
 *  - limit, offset
 */
router.get("/docs/pending", auth, requireRole("dosen"), async (req: AuthedRequest, res) => {
  try {
    const dosenId = await getDosenIdByUserId(req.user!.id);
    if (!dosenId) return res.status(403).json({ ok: false, message: "Dosen profile not found" });

    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const q = (req.query.q as string | undefined)?.trim();

    const where: string[] = [
      "vn.id_note IS NULL",
      // target this dosen OR legacy (no targets at all)
      `(EXISTS (SELECT 1 FROM check_target_dosen ctd WHERE ctd.id_check = cr.id_check AND ctd.id_dosen = ?)
        OR NOT EXISTS (SELECT 1 FROM check_target_dosen ctd2 WHERE ctd2.id_check = cr.id_check))`,
    ];
    const params: any[] = [dosenId];

    if (q) {
      where.push("(u.name LIKE ? OR m.nim LIKE ? OR ud.title LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
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
        m.nim AS requester_nim,
        m.prodi AS requester_prodi,
        ud.title AS doc_title,
        cr.finished_at
      FROM check_result cr2
      JOIN check_request cr ON cr.id_check = cr2.check_id
      JOIN users u ON u.id = cr.requested_by
      LEFT JOIN mahasiswa m ON m.user_id = u.id
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
      JOIN check_request cr ON cr.id_check = cr2.check_id
      JOIN users u ON u.id = cr.requested_by
      LEFT JOIN mahasiswa m ON m.user_id = u.id
      JOIN user_document ud ON ud.id_doc = cr.doc_id
      LEFT JOIN verification_note vn ON vn.result_id = cr2.id_result
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
 * GET /api/dosen/docs/checked
 * Dokumen yang sudah diverifikasi oleh dosen ini.
 * (dibatasi: hanya note yang verifier_id = dosen ini)
 *
 * Query: q, limit, offset, status (wajar|perlu_revisi|plagiarisme)
 */
router.get("/docs/checked", auth, requireRole("dosen"), async (req: AuthedRequest, res) => {
  try {
    const dosenId = await getDosenIdByUserId(req.user!.id);
    if (!dosenId) return res.status(403).json({ ok: false, message: "Dosen profile not found" });

    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const q = (req.query.q as string | undefined)?.trim();
    const status = (req.query.status as string | undefined)?.trim();

    const where: string[] = ["vn.verifier_id = ?"];
    const params: any[] = [dosenId];

    if (status && ["wajar", "perlu_revisi", "plagiarisme"].includes(status)) {
      where.push("vn.status = ?");
      params.push(status);
    }
    if (q) {
      where.push("(u.name LIKE ? OR m.nim LIKE ? OR ud.title LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
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
        m.nim AS requester_nim,
        m.prodi AS requester_prodi,
        ud.title AS doc_title,
        cr.finished_at,
        vn.id_note,
        vn.status AS verification_status,
        vn.note_text,
        vn.created_at AS note_created_at
      FROM check_result cr2
      JOIN check_request cr ON cr.id_check = cr2.check_id
      JOIN users u ON u.id = cr.requested_by
      LEFT JOIN mahasiswa m ON m.user_id = u.id
      JOIN user_document ud ON ud.id_doc = cr.doc_id
      JOIN verification_note vn ON vn.result_id = cr2.id_result
      ${whereSql}
      ORDER BY vn.created_at DESC
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
      LEFT JOIN mahasiswa m ON m.user_id = u.id
      JOIN user_document ud ON ud.id_doc = cr.doc_id
      JOIN verification_note vn ON vn.result_id = cr2.id_result
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
 * GET /api/dosen/results/:resultId/detail
 * Detail hasil pengecekan untuk dosen: preview dokumen + match spans +
 * excluded ranges (bagian yang tidak ikut dicek).
 *
 * Akses dibatasi: hanya dosen yang ditarget mahasiswa (atau legacy tanpa target).
 */
router.get("/results/:resultId/detail", auth, requireRole("dosen"), async (req: AuthedRequest, res) => {
  try {
    const dosenId = await getDosenIdByUserId(req.user!.id);
    if (!dosenId) return res.status(403).json({ ok: false, message: "Dosen profile not found" });

    const resultId = Number(req.params.resultId);
    if (!Number.isFinite(resultId) || resultId <= 0) {
      return res.status(400).json({ ok: false, message: "Invalid resultId" });
    }

    const access = await ensureDosenTargetedForResult(resultId, dosenId);
    if (!access.ok) {
      if (access.reason === "not_found") {
        return res.status(404).json({ ok: false, message: "Result not found" });
      }
      return res.status(403).json({
        ok: false,
        message: "Anda bukan dosen yang ditargetkan untuk dokumen ini",
      });
    }

    const [rRows] = await db.query<any[]>(
      `
      SELECT
        cr.id_check, cr.requested_by, cr.doc_id, cr.params_id,
        cr.status, cr.queued_at, cr.started_at, cr.finished_at,
        ud.title AS doc_title, ud.path_text,
        cr2.id_result, cr2.similarity, cr2.created_at AS result_created_at,
        cr2.summary_json
      FROM check_result cr2
      JOIN check_request cr ON cr.id_check = cr2.check_id
      JOIN user_document ud ON ud.id_doc = cr.doc_id
      WHERE cr2.id_result = ?
      LIMIT 1
      `,
      [resultId]
    );
    const row = rRows[0];
    if (!row) return res.status(404).json({ ok: false, message: "Result not found" });

    // mode pengecekan: true = metadata (penulis/univ/daftar pustaka) dikecualikan
    const excludeMetadata = readExcludeMetadata(row.summary_json);

    const [mRows] = await db.query<any[]>(
      `
      SELECT cm.*, cd.title AS corpus_title
      FROM check_match cm
      LEFT JOIN corpus_document cd ON cd.id_corpus = cm.source_id
      WHERE cm.result_id = ?
      ORDER BY cm.match_score DESC, cm.id_match ASC
      `,
      [resultId]
    );

    let doc_preview_text: string | null = null;
    let excluded_ranges: Array<{ start: number; end: number; reason: string }> = [];
    if (row.path_text) {
      const t = readTextSafe(row.path_text);
      doc_preview_text = t;
      excluded_ranges = excludeMetadata ? stripUncheckableSections(t).removed : [];
    }

    return res.json({
      ok: true,
      check: {
        id_check: row.id_check,
        requested_by: row.requested_by,
        doc_id: row.doc_id,
        params_id: row.params_id,
        status: row.status,
        queued_at: row.queued_at,
        started_at: row.started_at,
        finished_at: row.finished_at,
        doc_title: row.doc_title,
      },
      result: {
        id_result: row.id_result,
        similarity: row.similarity,
        created_at: row.result_created_at,
      },
      matches: mRows,
      doc_preview_text,
      excluded_ranges,
      exclude_metadata: excludeMetadata,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

export default router;
