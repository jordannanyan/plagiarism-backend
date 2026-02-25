import { Router } from "express";
import { db } from "../db";
import { auth, AuthedRequest } from "../middleware/auth";
import { requireRole } from "../middleware/role";
import { corpusUploader } from "../middleware/corpusUpload";
import path from "path";
import fs from "fs";
import { extractTextFromFile, normalizeTextBasic } from "../utils/textExtract";

const router = Router();
const upload = corpusUploader();

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

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/**
 * GET /api/corpus
 * query:
 *  - active=1|0 (optional)
 *  - q=keyword title (optional)
 *  - limit, offset
 */
router.get("/", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  try {
    const active = (req.query.active as string | undefined)?.trim();
    const q = (req.query.q as string | undefined)?.trim();
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    const where: string[] = [];
    const params: any[] = [];

    if (active === "1" || active === "0") {
      where.push("is_active = ?");
      params.push(Number(active));
    }
    if (q) {
      where.push("title LIKE ?");
      params.push(`%${q}%`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await db.query<any[]>(
      `
      SELECT id_corpus, title, source_type, source_ref, path_text, is_active, created_at, updated_at
      FROM corpus_document
      ${whereSql}
      ORDER BY id_corpus DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    const [countRows] = await db.query<any[]>(
      `SELECT COUNT(*) AS total FROM corpus_document ${whereSql}`,
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
 * POST /api/corpus/upload
 * form-data:
 *  - file: PDF/DOCX/TXT
 *  - title: string (optional)
 */
router.post(
  "/upload",
  auth,
  requireRole("admin"),
  upload.single("file"),
  async (req: AuthedRequest, res) => {
    const ip = getClientIp(req);

    try {
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) return res.status(400).json({ ok: false, message: "file is required" });

      // policy size check (lebih ketat dari multer)
      const policy = (req as any).__policy as { max_file_size: number; allowed_mime: string } | undefined;
      if (policy && file.size > policy.max_file_size) {
        try { fs.unlinkSync(file.path); } catch {}
        return res.status(400).json({
          ok: false,
          message: `File too large. Max: ${policy.max_file_size} bytes`,
        });
      }

      const title = (req.body?.title as string | undefined)?.trim() || file.originalname;

      // folder text corpus
      const TEXT_DIR = path.resolve(process.cwd(), "storage", "corpus", "text");
      ensureDir(TEXT_DIR);

      const textFilename = path.basename(file.filename) + ".txt";
      const textPath = path.join(TEXT_DIR, textFilename);

      // --- extraction beneran (TXT/PDF/DOCX) ---
      // fallback untuk kasus TXT kadang mimetype jadi octet-stream
      const isTxtByExt = file.originalname.toLowerCase().endsWith(".txt");
      const effectiveMime = isTxtByExt ? "text/plain" : file.mimetype;

      const extracted = await extractTextFromFile(file.path, effectiveMime);
      const normalized = normalizeTextBasic(extracted);

      fs.writeFileSync(textPath, normalized, "utf-8");

      const warning =
        normalized.length < 30
          ? "Extracted text is very short/empty. If PDF is scanned image, you need OCR to extract text."
          : null;

      const [ins] = await db.query<any>(
        `INSERT INTO corpus_document (title, source_type, source_ref, path_text, is_active)
         VALUES (?, 'upload', ?, ?, 1)`,
        [title, file.filename, textPath]
      );

      const corpusId = ins.insertId as number;

      await audit({
        user_id: req.user!.id,
        action: "ADMIN_UPLOAD_CORPUS",
        entity: "corpus_document",
        entity_id: corpusId,
        ip_addr: ip,
      });

      const [rows] = await db.query<any[]>(
        `SELECT id_corpus, title, source_type, source_ref, path_text, is_active, created_at, updated_at
         FROM corpus_document WHERE id_corpus = ? LIMIT 1`,
        [corpusId]
      );

      return res.status(201).json({ ok: true, corpus: rows[0], warning });
    } catch (e: any) {
      return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
    }
  }
);

/**
 * POST /api/corpus/url (opsional)
 * body: { title, url }
 * Untuk sekarang simpan metadata aja (tanpa fetch).
 */
router.post("/url", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  const ip = getClientIp(req);

  try {
    const { title, url } = req.body as { title?: string; url?: string };
    if (!title || !url) return res.status(400).json({ ok: false, message: "title and url required" });

    const [ins] = await db.query<any>(
      `INSERT INTO corpus_document (title, source_type, source_ref, path_text, is_active)
       VALUES (?, 'url', ?, ?, 1)`,
      [title, url, ""]
    );

    const corpusId = ins.insertId as number;

    await audit({
      user_id: req.user!.id,
      action: "ADMIN_ADD_CORPUS_URL",
      entity: "corpus_document",
      entity_id: corpusId,
      ip_addr: ip,
    });

    const [rows] = await db.query<any[]>(
      `SELECT id_corpus, title, source_type, source_ref, path_text, is_active, created_at, updated_at
       FROM corpus_document WHERE id_corpus = ? LIMIT 1`,
      [corpusId]
    );

    return res.status(201).json({ ok: true, corpus: rows[0] });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

/**
 * PATCH /api/corpus/:id
 * body: { title?, is_active? }
 */
router.patch("/:id", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  const ip = getClientIp(req);

  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, message: "Invalid corpus id" });

  try {
    const sets: string[] = [];
    const params: any[] = [];

    if (req.body.title !== undefined) {
      sets.push("title = ?");
      params.push(String(req.body.title));
    }
    if (req.body.is_active !== undefined) {
      const v = req.body.is_active === true || req.body.is_active === 1 || req.body.is_active === "1" ? 1 : 0;
      sets.push("is_active = ?");
      params.push(v);
    }

    if (sets.length === 0) return res.status(400).json({ ok: false, message: "No fields to update" });

    const [result] = await db.query<any>(
      `UPDATE corpus_document SET ${sets.join(", ")} WHERE id_corpus = ?`,
      [...params, id]
    );

    if (result.affectedRows === 0) return res.status(404).json({ ok: false, message: "Corpus not found" });

    await audit({
      user_id: req.user!.id,
      action: "ADMIN_UPDATE_CORPUS",
      entity: "corpus_document",
      entity_id: id,
      ip_addr: ip,
    });

    const [rows] = await db.query<any[]>(
      `SELECT id_corpus, title, source_type, source_ref, path_text, is_active, created_at, updated_at
       FROM corpus_document WHERE id_corpus = ? LIMIT 1`,
      [id]
    );

    return res.json({ ok: true, corpus: rows[0] });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

/**
 * DELETE /api/corpus/:id
 */
router.delete("/:id", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  const ip = getClientIp(req);

  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, message: "Invalid corpus id" });

  try {
    const [rows] = await db.query<any[]>(
      `SELECT id_corpus, source_type, source_ref, path_text FROM corpus_document WHERE id_corpus = ? LIMIT 1`,
      [id]
    );
    const corpus = rows[0];
    if (!corpus) return res.status(404).json({ ok: false, message: "Corpus not found" });

    await db.query(`DELETE FROM fingerprint_corpus WHERE corpus_id = ?`, [id]);
    await db.query(`DELETE FROM corpus_document WHERE id_corpus = ?`, [id]);

    if (corpus.source_type === "upload" && corpus.source_ref) {
      const rawPath = path.resolve(process.cwd(), "storage", "corpus", "raw", corpus.source_ref);
      try { fs.unlinkSync(rawPath); } catch {}
    }
    if (corpus.path_text) {
      try { fs.unlinkSync(corpus.path_text); } catch {}
    }

    await audit({
      user_id: req.user!.id,
      action: "ADMIN_DELETE_CORPUS",
      entity: "corpus_document",
      entity_id: id,
      ip_addr: ip,
    });

    return res.json({ ok: true, message: "Corpus deleted" });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

/**
 * POST /api/corpus/:id/reindex
 * Stub dulu
 */
router.post("/:id/reindex", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  const ip = getClientIp(req);
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, message: "Invalid corpus id" });

  await audit({
    user_id: req.user!.id,
    action: "ADMIN_REINDEX_CORPUS_REQUESTED",
    entity: "corpus_document",
    entity_id: id,
    ip_addr: ip,
  });

  return res.json({
    ok: true,
    message: "Reindex requested (stub). We will implement fingerprinting next.",
  });
});

/**
 * POST /api/corpus/reindex-all
 * Stub dulu
 */
router.post("/reindex-all", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  const ip = getClientIp(req);

  await audit({
    user_id: req.user!.id,
    action: "ADMIN_REINDEX_ALL_REQUESTED",
    entity: "corpus_document",
    entity_id: null,
    ip_addr: ip,
  });

  return res.json({
    ok: true,
    message: "Reindex-all requested (stub). We will implement fingerprinting next.",
  });
});

export default router;