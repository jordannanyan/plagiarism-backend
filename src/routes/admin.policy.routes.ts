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
  } catch {
    // ignore
  }
}

/**
 * GET /api/admin/policy
 * Returns the latest policy row.
 */
router.get("/", auth, requireRole("admin"), async (_req: AuthedRequest, res) => {
  try {
    const [rows] = await db.query<any[]>(
      `SELECT id_policy, max_file_size, allowed_mime, notes, created_at, updated_at
       FROM policy
       ORDER BY id_policy DESC
       LIMIT 1`
    );

    // Jika belum ada policy, return null (atau kamu bisa auto-create)
    return res.json({ ok: true, policy: rows[0] ?? null });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

/**
 * PUT /api/admin/policy
 * body:
 *  { max_file_size?: number, allowed_mime?: string, notes?: string }
 *
 * Strategy: create a new row (history-friendly), not overwrite.
 */
router.put("/", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  const ip = getClientIp(req);

  try {
    const body = req.body as {
      max_file_size?: number;
      allowed_mime?: string;
      notes?: string;
    };

    // Basic validation
    const maxFileSize =
      body.max_file_size !== undefined ? Number(body.max_file_size) : undefined;

    if (maxFileSize !== undefined && (!Number.isFinite(maxFileSize) || maxFileSize <= 0)) {
      return res.status(400).json({ ok: false, message: "max_file_size must be a positive number" });
    }

    // Get current policy for fallback values
    const [curRows] = await db.query<any[]>(
      `SELECT id_policy, max_file_size, allowed_mime, notes
       FROM policy
       ORDER BY id_policy DESC
       LIMIT 1`
    );
    const cur = curRows[0];

    const finalMax = maxFileSize ?? (cur?.max_file_size ?? 10485760);
    const finalMime = body.allowed_mime ?? (cur?.allowed_mime ?? "application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain");
    const finalNotes = body.notes ?? (cur?.notes ?? null);

    const [ins] = await db.query<any>(
      `INSERT INTO policy (max_file_size, allowed_mime, notes)
       VALUES (?, ?, ?)`,
      [finalMax, finalMime, finalNotes]
    );

    const newId = ins.insertId as number;

    await audit({
      user_id: req.user!.id,
      action: "ADMIN_UPDATE_POLICY",
      entity: "policy",
      entity_id: newId,
      ip_addr: ip,
    });

    const [rows] = await db.query<any[]>(
      `SELECT id_policy, max_file_size, allowed_mime, notes, created_at, updated_at
       FROM policy
       WHERE id_policy = ?
       LIMIT 1`,
      [newId]
    );

    return res.json({ ok: true, policy: rows[0] });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

export default router;