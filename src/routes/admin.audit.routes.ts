import { Router } from "express";
import { db } from "../db";
import { auth } from "../middleware/auth";
import { requireRole } from "../middleware/role";

const router = Router();

/**
 * GET /api/admin/audit
 * Admin only — paginated audit log with optional filters.
 *
 * Query:
 *  - q          : search by user name, email, or action (LIKE)
 *  - user_id    : filter by specific user
 *  - action     : exact match on action string
 *  - entity     : exact match on entity string
 *  - from       : ISO date string — timestamp >= from
 *  - to         : ISO date string — timestamp <= to
 *  - limit      : default 50, max 200
 *  - offset     : default 0
 */
router.get("/", auth, requireRole("admin"), async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    const q = (req.query.q as string | undefined)?.trim();
    const userIdFilter = req.query.user_id ? Number(req.query.user_id) : null;
    const actionFilter = (req.query.action as string | undefined)?.trim() || null;
    const entityFilter = (req.query.entity as string | undefined)?.trim() || null;
    const fromDate = (req.query.from as string | undefined)?.trim() || null;
    const toDate = (req.query.to as string | undefined)?.trim() || null;

    const where: string[] = [];
    const params: any[] = [];

    if (q) {
      where.push("(u.name LIKE ? OR u.email LIKE ? OR al.action LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (userIdFilter !== null && Number.isFinite(userIdFilter)) {
      where.push("al.user_id = ?");
      params.push(userIdFilter);
    }
    if (actionFilter) {
      where.push("al.action = ?");
      params.push(actionFilter);
    }
    if (entityFilter) {
      where.push("al.entity = ?");
      params.push(entityFilter);
    }
    if (fromDate) {
      where.push("al.timestamp >= ?");
      params.push(fromDate);
    }
    if (toDate) {
      where.push("al.timestamp <= ?");
      params.push(toDate);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await db.query<any[]>(
      `
      SELECT
        al.id_log,
        al.user_id,
        al.action,
        al.entity,
        al.entity_id,
        al.ip_addr,
        al.timestamp,
        u.name  AS user_name,
        u.email AS user_email,
        r.name  AS user_role
      FROM audit_log al
      LEFT JOIN users u ON u.id = al.user_id
      LEFT JOIN roles r ON r.id = u.role_id
      ${whereSql}
      ORDER BY al.id_log DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    const [countRows] = await db.query<any[]>(
      `
      SELECT COUNT(*) AS total
      FROM audit_log al
      LEFT JOIN users u ON u.id = al.user_id
      ${whereSql}
      `,
      params
    );

    // distinct action values for filter dropdown
    const [actionRows] = await db.query<any[]>(
      `SELECT DISTINCT action FROM audit_log ORDER BY action ASC`
    );

    return res.json({
      ok: true,
      total: countRows?.[0]?.total ?? 0,
      limit,
      offset,
      rows,
      actions: (actionRows as any[]).map((a) => a.action as string),
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

export default router;
