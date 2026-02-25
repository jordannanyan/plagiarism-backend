import { Request, Response, NextFunction } from "express";
import { verifyJwt } from "../utils/auth";

export type AuthedRequest = Request & {
  user?: { id: number; role: string; email: string; name: string };
};

export function auth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, message: "Missing Bearer token" });
  }

  const token = header.slice("Bearer ".length);
  try {
    const decoded = verifyJwt(token) as any;
    req.user = {
      id: decoded.id,
      role: decoded.role,
      email: decoded.email,
      name: decoded.name,
    };
    return next();
  } catch {
    return res.status(401).json({ ok: false, message: "Invalid token" });
  }
}