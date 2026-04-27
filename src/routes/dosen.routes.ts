import { Router } from "express";
import { db } from "../db";
import { auth, AuthedRequest } from "../middleware/auth";
import { requireRole } from "../middleware/role";

const router = Router();

async function getDosenIdByUserId(userId: number): Promise<number | null> {
  const [rows] = await db.query<any[]>(
    `SELECT id_dosen FROM dosen WHERE user_id = ? LIMIT 1`,
    [userId]
  );
  return rows?.[0]?.id_dosen ?? null;
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

export default router;
