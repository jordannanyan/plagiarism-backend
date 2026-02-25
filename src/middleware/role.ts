import { Response, NextFunction } from "express";
import type { AuthedRequest } from "./auth";

export function requireRole(...roles: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (!role) return res.status(401).json({ ok: false, message: "Unauthorized" });

    if (!roles.includes(role)) {
      return res.status(403).json({ ok: false, message: "Forbidden" });
    }
    return next();
  };
}