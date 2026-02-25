import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

export function signJwt(payload: object) {
  const secret = process.env.JWT_SECRET || "dev_secret";
  return jwt.sign(payload, secret, { expiresIn: "7d" });
}

export function verifyJwt(token: string) {
  const secret = process.env.JWT_SECRET || "dev_secret";
  return jwt.verify(token, secret);
}

export async function hashPassword(plain: string) {
  return bcrypt.hash(plain, 10);
}

export async function comparePassword(plain: string, hash: string) {
  return bcrypt.compare(plain, hash);
}