import { Router } from "express";
import { db } from "../db";
import { comparePassword, signJwt } from "../utils/auth";
import { auth, AuthedRequest } from "../middleware/auth";

const router = Router();

function getClientIp(req: any): string | null {
  // Kalau pakai reverse proxy (nginx), aktifkan trust proxy di app.ts juga
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) return xf.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

async function writeAuditLog(params: {
  user_id: number | null;
  action: string;
  entity?: string | null;
  entity_id?: number | null;
  ip_addr?: string | null;
}) {
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, ip_addr)
       VALUES (?, ?, ?, ?, ?)`,
      [
        params.user_id, // NOTE: user_id di tabel audit_log NOT NULL, lihat catatan di bawah
        params.action,
        params.entity ?? null,
        params.entity_id ?? null,
        params.ip_addr ?? null,
      ]
    );
  } catch {
    // jangan ganggu flow login kalau audit gagal
  }
}

/**
 * POST /api/auth/login
 * body: { email, password }
 */
router.post("/login", async (req, res) => {
  const ip = getClientIp(req);

  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      return res.status(400).json({ ok: false, message: "email and password required" });
    }

    const [rows] = await db.query<any[]>(
      `
      SELECT u.id, u.name, u.email, u.password_hash, r.name AS role
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.email = ? AND u.is_active = 1
      LIMIT 1
      `,
      [email]
    );

    const user = rows[0];

    // Jika user tidak ditemukan, kita tetap bisa log, tapi butuh user_id.
    // Karena audit_log.user_id kamu NOT NULL, kita log ke user admin sistem (lihat catatan).
    if (!user) {
      // writeAuditLog({ user_id: SYSTEM_USER_ID, action: "LOGIN_FAILED", entity: "users", entity_id: null, ip_addr: ip });
      return res.status(401).json({ ok: false, message: "Invalid credentials" });
    }

    const ok = await comparePassword(password, user.password_hash);
    if (!ok) {
      await writeAuditLog({
        user_id: user.id,
        action: "LOGIN_FAILED",
        entity: "users",
        entity_id: user.id,
        ip_addr: ip,
      });
      return res.status(401).json({ ok: false, message: "Invalid credentials" });
    }

    const token = signJwt({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    });

    await writeAuditLog({
      user_id: user.id,
      action: "LOGIN_SUCCESS",
      entity: "users",
      entity_id: user.id,
      ip_addr: ip,
    });

    return res.json({
      ok: true,
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

/**
 * GET /api/auth/me
 */
router.get("/me", auth, async (req: AuthedRequest, res) => {
  return res.json({ ok: true, user: req.user });
});

/**
 * POST /api/auth/logout
 * Requires Bearer token
 */
router.post("/logout", auth, async (req: AuthedRequest, res) => {
  try {
    const ip =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.ip ||
      null;

    await db.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, ip_addr)
       VALUES (?, ?, ?, ?, ?)`,
      [
        req.user!.id,
        "LOGOUT",
        "users",
        req.user!.id,
        ip,
      ]
    );

    return res.json({ ok: true, message: "Logged out successfully" });
  } catch (e: any) {
    return res.status(500).json({
      ok: false,
      message: e?.message ?? "Logout error",
    });
  }
});

export default router;