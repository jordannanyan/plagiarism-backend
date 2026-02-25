import { Router } from "express";
import { db } from "../db";
import { auth, AuthedRequest } from "../middleware/auth";
import { requireRole } from "../middleware/role";
import { hashPassword } from "../utils/auth";

const router = Router();

/** Helper ambil IP */
function getClientIp(req: any): string | null {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) return xf.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

/** Audit log helper */
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
    // jangan ganggu flow
  }
}

/**
 * GET /api/admin/users
 * Query:
 *  - role=admin|dosen|mahasiswa (optional)
 *  - q=keyword (name/email) (optional)
 *  - is_active=0|1 (optional)
 *  - limit, offset (optional)
 */
router.get("/", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  try {
    const role = (req.query.role as string | undefined)?.trim();
    const q = (req.query.q as string | undefined)?.trim();
    const isActiveRaw = req.query.is_active as string | undefined;

    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    const where: string[] = [];
    const params: any[] = [];

    if (role) {
      where.push("r.name = ?");
      params.push(role);
    }
    if (q) {
      where.push("(u.name LIKE ? OR u.email LIKE ?)");
      params.push(`%${q}%`, `%${q}%`);
    }
    if (isActiveRaw === "0" || isActiveRaw === "1") {
      where.push("u.is_active = ?");
      params.push(Number(isActiveRaw));
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await db.query<any[]>(
      `
      SELECT
        u.id, u.name, u.email, u.is_active, u.created_at, u.updated_at,
        r.name AS role,
        d.id_dosen, d.nidn, d.nama AS dosen_nama, d.telp AS dosen_telp,
        m.id_mhs, m.nim, m.prodi, m.angkatan
      FROM users u
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN dosen d ON d.user_id = u.id
      LEFT JOIN mahasiswa m ON m.user_id = u.id
      ${whereSql}
      ORDER BY u.id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    const [countRows] = await db.query<any[]>(
      `
      SELECT COUNT(*) AS total
      FROM users u
      JOIN roles r ON r.id = u.role_id
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
 * POST /api/admin/users
 * body:
 *  {
 *    role: "dosen" | "mahasiswa",
 *    name, email, password,
 *    dosen?: { nidn?, nama?, telp? }
 *    mahasiswa?: { nim?, prodi?, angkatan? }
 *  }
 */
router.post("/", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  const ip = getClientIp(req);

  const body = req.body as any;
  const role = (body.role as string | undefined)?.trim();

  if (!role || !["dosen", "mahasiswa"].includes(role)) {
    return res.status(400).json({ ok: false, message: "role must be 'dosen' or 'mahasiswa'" });
  }
  if (!body.name || !body.email || !body.password) {
    return res.status(400).json({ ok: false, message: "name, email, password are required" });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // cek role_id
    const [roleRows] = await conn.query<any[]>("SELECT id FROM roles WHERE name = ? LIMIT 1", [role]);
    const roleId = roleRows?.[0]?.id;
    if (!roleId) {
      await conn.rollback();
      return res.status(400).json({ ok: false, message: `role '${role}' not found in roles table` });
    }

    // cek email unik
    const [exists] = await conn.query<any[]>("SELECT id FROM users WHERE email = ? LIMIT 1", [body.email]);
    if (exists.length > 0) {
      await conn.rollback();
      return res.status(409).json({ ok: false, message: "Email already exists" });
    }

    const pwdHash = await hashPassword(body.password);

    // insert user
    const [insUser] = await conn.query<any>(
      `INSERT INTO users (name, email, password_hash, role_id, is_active)
       VALUES (?, ?, ?, ?, 1)`,
      [body.name, body.email, pwdHash, roleId]
    );

    const userId = insUser.insertId as number;

    // insert profil sesuai role
    if (role === "dosen") {
      const d = body.dosen ?? {};
      const namaDosen = (d.nama ?? body.name) as string;

      await conn.query(
        `INSERT INTO dosen (user_id, nidn, nama, telp)
         VALUES (?, ?, ?, ?)`,
        [userId, d.nidn ?? null, namaDosen, d.telp ?? null]
      );
    } else {
      const m = body.mahasiswa ?? {};
      await conn.query(
        `INSERT INTO mahasiswa (user_id, nim, prodi, angkatan)
         VALUES (?, ?, ?, ?)`,
        [userId, m.nim ?? null, m.prodi ?? null, m.angkatan ?? null]
      );
    }

    await conn.commit();

    await audit({
      user_id: req.user!.id,
      action: "ADMIN_CREATE_USER",
      entity: "users",
      entity_id: userId,
      ip_addr: ip,
    });

    return res.status(201).json({
      ok: true,
      user: {
        id: userId,
        name: body.name,
        email: body.email,
        role,
        is_active: 1,
      },
    });
  } catch (e: any) {
    await conn.rollback();
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  } finally {
    conn.release();
  }
});

/**
 * PATCH /api/admin/users/:id
 * body:
 *  {
 *    name?, email?, password?, is_active?,
 *    dosen?: { nidn?, nama?, telp? }
 *    mahasiswa?: { nim?, prodi?, angkatan? }
 *  }
 */
router.patch("/:id", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  const ip = getClientIp(req);

  const userId = Number(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ ok: false, message: "Invalid user id" });
  }

  const body = req.body as any;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query<any[]>(
      `SELECT u.id, u.role_id, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.id = ? LIMIT 1`,
      [userId]
    );
    const user = rows[0];
    if (!user) {
      await conn.rollback();
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    // update users fields
    const sets: string[] = [];
    const params: any[] = [];

    if (body.name !== undefined) {
      sets.push("name = ?");
      params.push(body.name);
    }
    if (body.email !== undefined) {
      // cek email unik
      const [ex] = await conn.query<any[]>("SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1", [
        body.email,
        userId,
      ]);
      if (ex.length > 0) {
        await conn.rollback();
        return res.status(409).json({ ok: false, message: "Email already exists" });
      }
      sets.push("email = ?");
      params.push(body.email);
    }
    if (body.is_active !== undefined) {
      const v = body.is_active === true || body.is_active === 1 || body.is_active === "1" ? 1 : 0;
      sets.push("is_active = ?");
      params.push(v);
    }
    if (body.password !== undefined) {
      const pwdHash = await hashPassword(String(body.password));
      sets.push("password_hash = ?");
      params.push(pwdHash);
    }

    if (sets.length > 0) {
      await conn.query(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, [...params, userId]);
    }

    // update profile table based on role
    if (user.role === "dosen" && body.dosen) {
      const d = body.dosen;
      const dSets: string[] = [];
      const dParams: any[] = [];
      if (d.nidn !== undefined) { dSets.push("nidn = ?"); dParams.push(d.nidn); }
      if (d.nama !== undefined) { dSets.push("nama = ?"); dParams.push(d.nama); }
      if (d.telp !== undefined) { dSets.push("telp = ?"); dParams.push(d.telp); }
      if (dSets.length > 0) {
        await conn.query(`UPDATE dosen SET ${dSets.join(", ")} WHERE user_id = ?`, [...dParams, userId]);
      }
    }

    if (user.role === "mahasiswa" && body.mahasiswa) {
      const m = body.mahasiswa;
      const mSets: string[] = [];
      const mParams: any[] = [];
      if (m.nim !== undefined) { mSets.push("nim = ?"); mParams.push(m.nim); }
      if (m.prodi !== undefined) { mSets.push("prodi = ?"); mParams.push(m.prodi); }
      if (m.angkatan !== undefined) { mSets.push("angkatan = ?"); mParams.push(m.angkatan); }
      if (mSets.length > 0) {
        await conn.query(`UPDATE mahasiswa SET ${mSets.join(", ")} WHERE user_id = ?`, [...mParams, userId]);
      }
    }

    await conn.commit();

    await audit({
      user_id: req.user!.id,
      action: "ADMIN_UPDATE_USER",
      entity: "users",
      entity_id: userId,
      ip_addr: ip,
    });

    return res.json({ ok: true, message: "User updated" });
  } catch (e: any) {
    await conn.rollback();
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  } finally {
    conn.release();
  }
});

/**
 * DELETE /api/admin/users/:id
 * NOTE: demi aman dengan FK, ini kita buat sebagai "soft delete"
 * -> set is_active = 0
 */
router.delete("/:id", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  const ip = getClientIp(req);

  const userId = Number(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ ok: false, message: "Invalid user id" });
  }

  try {
    const [result] = await db.query<any>(`UPDATE users SET is_active = 0 WHERE id = ?`, [userId]);
    if (result.affectedRows === 0) return res.status(404).json({ ok: false, message: "User not found" });

    await audit({
      user_id: req.user!.id,
      action: "ADMIN_DEACTIVATE_USER",
      entity: "users",
      entity_id: userId,
      ip_addr: ip,
    });

    return res.json({ ok: true, message: "User deactivated (soft delete)" });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

export default router;