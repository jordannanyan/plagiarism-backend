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
 * GET /api/admin/params
 * Query:
 *  - active=1 (optional) -> only currently active (active_to IS NULL OR active_to > now)
 */
router.get("/", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  try {
    const active = (req.query.active as string | undefined)?.trim();

    let sql = `
      SELECT id_params, k, w, base, threshold, active_from, active_to
      FROM algoritma_params
    `;
    const params: any[] = [];

    if (active === "1") {
      sql += ` WHERE (active_to IS NULL OR active_to > NOW()) AND active_from <= NOW() `;
    }

    sql += ` ORDER BY id_params DESC`;

    const [rows] = await db.query<any[]>(sql, params);
    return res.json({ ok: true, rows });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

/**
 * POST /api/admin/params
 * body: { k, w, base, threshold, active_from? }
 */
router.post("/", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  const ip = getClientIp(req);

  try {
    const body = req.body as {
      k?: number;
      w?: number;
      base?: number;
      threshold?: number;
      active_from?: string;
    };

    const k = Number(body.k);
    const w = Number(body.w);
    const base = Number(body.base);
    const threshold = Number(body.threshold);

    if (!Number.isFinite(k) || k <= 0) return res.status(400).json({ ok: false, message: "k must be > 0" });
    if (!Number.isFinite(w) || w <= 0) return res.status(400).json({ ok: false, message: "w must be > 0" });
    if (!Number.isFinite(base) || base <= 0) return res.status(400).json({ ok: false, message: "base must be > 0" });
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      return res.status(400).json({ ok: false, message: "threshold must be between 0 and 1" });
    }

    const activeFrom = body.active_from ? new Date(body.active_from) : new Date();
    if (Number.isNaN(activeFrom.getTime())) {
      return res.status(400).json({ ok: false, message: "active_from must be a valid datetime" });
    }

    const [ins] = await db.query<any>(
      `INSERT INTO algoritma_params (k, w, base, threshold, active_from, active_to)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      [k, w, base, threshold, activeFrom]
    );

    const newId = ins.insertId as number;

    await audit({
      user_id: req.user!.id,
      action: "ADMIN_CREATE_PARAMS",
      entity: "algoritma_params",
      entity_id: newId,
      ip_addr: ip,
    });

    const [rows] = await db.query<any[]>(
      `SELECT id_params, k, w, base, threshold, active_from, active_to
       FROM algoritma_params
       WHERE id_params = ?
       LIMIT 1`,
      [newId]
    );

    return res.status(201).json({ ok: true, params: rows[0] });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

/**
 * PUT /api/admin/params/:id
 * body: { k?, w?, base?, threshold?, active_from?, active_to? }
 *
 * Untuk menjaga histori, biasanya lebih aman:
 * - set active_to (menonaktifkan params lama)
 * - lalu POST params baru
 *
 * Tapi endpoint ini tetap disediakan untuk opsional.
 */
router.put("/:id", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  const ip = getClientIp(req);

  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ ok: false, message: "Invalid params id" });
  }

  try {
    // Pastikan ada row
    const [existing] = await db.query<any[]>(
      `SELECT id_params FROM algoritma_params WHERE id_params = ? LIMIT 1`,
      [id]
    );
    if (!existing[0]) return res.status(404).json({ ok: false, message: "Params not found" });

    const body = req.body as any;
    const sets: string[] = [];
    const params: any[] = [];

    if (body.k !== undefined) { sets.push("k = ?"); params.push(Number(body.k)); }
    if (body.w !== undefined) { sets.push("w = ?"); params.push(Number(body.w)); }
    if (body.base !== undefined) { sets.push("base = ?"); params.push(Number(body.base)); }
    if (body.threshold !== undefined) { sets.push("threshold = ?"); params.push(Number(body.threshold)); }

    if (body.active_from !== undefined) {
      const d = new Date(body.active_from);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ ok: false, message: "active_from invalid datetime" });
      sets.push("active_from = ?");
      params.push(d);
    }

    if (body.active_to !== undefined) {
      const d = body.active_to === null ? null : new Date(body.active_to);
      if (d !== null && Number.isNaN(d.getTime())) return res.status(400).json({ ok: false, message: "active_to invalid datetime" });
      sets.push("active_to = ?");
      params.push(d);
    }

    if (sets.length === 0) {
      return res.status(400).json({ ok: false, message: "No fields to update" });
    }

    // Basic validation after cast (only for provided)
    for (let i = 0; i < sets.length; i++) {
      // optional, keep simple
    }

    await db.query(`UPDATE algoritma_params SET ${sets.join(", ")} WHERE id_params = ?`, [...params, id]);

    await audit({
      user_id: req.user!.id,
      action: "ADMIN_UPDATE_PARAMS",
      entity: "algoritma_params",
      entity_id: id,
      ip_addr: ip,
    });

    const [rows] = await db.query<any[]>(
      `SELECT id_params, k, w, base, threshold, active_from, active_to
       FROM algoritma_params
       WHERE id_params = ?
       LIMIT 1`,
      [id]
    );

    return res.json({ ok: true, params: rows[0] });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

export default router;