import { Router } from "express";
import { db } from "../db";
import { auth, AuthedRequest } from "../middleware/auth";
import { requireRole } from "../middleware/role";
import { userDocUploader } from "../middleware/userDocUpload";
import { extractTextFromFile, normalizeTextBasic } from "../utils/textExtract";
import path from "path";
import fs from "fs";

const router = Router();
const upload = userDocUploader();

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

const TEXT_DIR = path.resolve(process.cwd(), "storage", "user_docs", "text");
ensureDir(TEXT_DIR);

/**
 * POST /api/documents/upload
 * Roles: mahasiswa, dosen
 * form-data:
 *  - file: PDF/DOCX/TXT
 *  - title: optional
 */
router.post(
  "/upload",
  auth,
  requireRole("mahasiswa", "dosen"),
  upload.single("file"),
  async (req: AuthedRequest, res) => {
    const ip = getClientIp(req);

    try {
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) return res.status(400).json({ ok: false, message: "file is required" });

      const policy = (req as any).__policy as { max_file_size: number } | undefined;
      if (policy && file.size > policy.max_file_size) {
        try { fs.unlinkSync(file.path); } catch {}
        return res.status(400).json({ ok: false, message: `File too large. Max ${policy.max_file_size} bytes` });
      }

      const title = (req.body?.title as string | undefined)?.trim() || file.originalname;

      // extract text
      const extracted = await extractTextFromFile(file.path, file.mimetype);
      const normalized = normalizeTextBasic(extracted);

      const textFilename = path.basename(file.filename) + ".txt";
      const textPath = path.join(TEXT_DIR, textFilename);
      fs.writeFileSync(textPath, normalized, "utf-8");

      const [ins] = await db.query<any>(
        `INSERT INTO user_document
          (owner_user_id, title, mime_type, size_bytes, status, path_raw, path_text)
         VALUES (?, ?, ?, ?, 'done', ?, ?)`,
        [req.user!.id, title, file.mimetype, file.size, file.filename, textPath]
      );

      const docId = ins.insertId as number;

      await audit({
        user_id: req.user!.id,
        action: "UPLOAD_USER_DOCUMENT",
        entity: "user_document",
        entity_id: docId,
        ip_addr: ip,
      });

      const [rows] = await db.query<any[]>(
        `SELECT id_doc, owner_user_id, title, mime_type, size_bytes, status, path_raw, path_text, created_at, updated_at
         FROM user_document WHERE id_doc = ? LIMIT 1`,
        [docId]
      );

      return res.status(201).json({ ok: true, document: rows[0] });
    } catch (e: any) {
      return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
    }
  }
);

/**
 * POST /api/documents/text
 * body: { title?, text }
 */
router.post("/text", auth, requireRole("mahasiswa", "dosen"), async (req: AuthedRequest, res) => {
  const ip = getClientIp(req);

  try {
    const { title, text } = req.body as { title?: string; text?: string };
    if (!text || !text.trim()) return res.status(400).json({ ok: false, message: "text is required" });

    const finalTitle = (title?.trim() || "Text Input").slice(0, 255);
    const normalized = normalizeTextBasic(text);

    const textFilename = `${Date.now()}_text_${req.user!.id}.txt`;
    const textPath = path.join(TEXT_DIR, textFilename);
    fs.writeFileSync(textPath, normalized, "utf-8");

    const sizeBytes = Buffer.byteLength(normalized, "utf-8");

    const [ins] = await db.query<any>(
      `INSERT INTO user_document
        (owner_user_id, title, mime_type, size_bytes, status, path_raw, path_text)
       VALUES (?, ?, 'text/plain', ?, 'done', NULL, ?)`,
      [req.user!.id, finalTitle, sizeBytes, textPath]
    );

    const docId = ins.insertId as number;

    await audit({
      user_id: req.user!.id,
      action: "SUBMIT_TEXT_DOCUMENT",
      entity: "user_document",
      entity_id: docId,
      ip_addr: ip,
    });

    const [rows] = await db.query<any[]>(
      `SELECT id_doc, owner_user_id, title, mime_type, size_bytes, status, path_raw, path_text, created_at, updated_at
       FROM user_document WHERE id_doc = ? LIMIT 1`,
      [docId]
    );

    return res.status(201).json({ ok: true, document: rows[0] });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

/**
 * GET /api/documents
 * List docs milik user
 * query: limit, offset
 */
router.get("/", auth, requireRole("mahasiswa", "dosen"), async (req: AuthedRequest, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    const [rows] = await db.query<any[]>(
      `
      SELECT id_doc, owner_user_id, title, mime_type, size_bytes, status, path_raw, path_text, created_at, updated_at
      FROM user_document
      WHERE owner_user_id = ?
      ORDER BY id_doc DESC
      LIMIT ? OFFSET ?
      `,
      [req.user!.id, limit, offset]
    );

    const [countRows] = await db.query<any[]>(
      `SELECT COUNT(*) AS total FROM user_document WHERE owner_user_id = ?`,
      [req.user!.id]
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
 * GET /api/documents/:id
 * Detail + preview text (first N chars)
 * query: preview=1 (default), max_chars=5000
 */
router.get("/:id", auth, requireRole("mahasiswa", "dosen"), async (req: AuthedRequest, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, message: "Invalid document id" });

    const [rows] = await db.query<any[]>(
      `
      SELECT id_doc, owner_user_id, title, mime_type, size_bytes, status, path_raw, path_text, created_at, updated_at
      FROM user_document
      WHERE id_doc = ? AND owner_user_id = ?
      LIMIT 1
      `,
      [id, req.user!.id]
    );

    const doc = rows[0];
    if (!doc) return res.status(404).json({ ok: false, message: "Document not found" });

    const previewEnabled = (req.query.preview as string | undefined) !== "0";
    const maxChars = Math.min(Number(req.query.max_chars ?? 5000), 20000);

    let previewText: string | null = null;
    if (previewEnabled && doc.path_text) {
      try {
        const txt = fs.readFileSync(doc.path_text, "utf-8");
        previewText = txt.slice(0, maxChars);
      } catch {
        previewText = null;
      }
    }

    return res.json({ ok: true, document: doc, preview_text: previewText });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

/**
 * DELETE /api/documents/:id
 * Delete doc milik user + hapus file raw/text
 */
router.delete("/:id", auth, requireRole("mahasiswa", "dosen"), async (req: AuthedRequest, res) => {
  const ip = getClientIp(req);

  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, message: "Invalid document id" });

    const [rows] = await db.query<any[]>(
      `SELECT id_doc, path_raw, path_text, mime_type FROM user_document WHERE id_doc = ? AND owner_user_id = ? LIMIT 1`,
      [id, req.user!.id]
    );
    const doc = rows[0];
    if (!doc) return res.status(404).json({ ok: false, message: "Document not found" });

    // delete fingerprints if sudah pernah dibuat nanti
    await db.query(`DELETE FROM fingerprint_user WHERE doc_id = ?`, [id]);

    // delete row
    await db.query(`DELETE FROM user_document WHERE id_doc = ?`, [id]);

    // delete files
    if (doc.path_raw) {
      const rawPath = path.resolve(process.cwd(), "storage", "user_docs", "raw", doc.path_raw);
      try { fs.unlinkSync(rawPath); } catch {}
    }
    if (doc.path_text) {
      try { fs.unlinkSync(doc.path_text); } catch {}
    }

    await audit({
      user_id: req.user!.id,
      action: "DELETE_USER_DOCUMENT",
      entity: "user_document",
      entity_id: id,
      ip_addr: ip,
    });

    return res.json({ ok: true, message: "Document deleted" });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

export default router;