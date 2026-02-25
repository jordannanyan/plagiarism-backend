import multer from "multer";
import path from "path";
import fs from "fs";
import { db } from "../db";

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

const RAW_DIR = path.resolve(process.cwd(), "storage", "user_docs", "raw");
ensureDir(RAW_DIR);

async function getLatestPolicy() {
  const [rows] = await db.query<any[]>(
    `SELECT max_file_size, allowed_mime
     FROM policy
     ORDER BY id_policy DESC
     LIMIT 1`
  );
  const p = rows[0];
  return {
    max_file_size: Number(p?.max_file_size ?? 10485760),
    allowed_mime: String(
      p?.allowed_mime ??
        "application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
    ),
  };
}

export function userDocUploader() {
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, RAW_DIR),
    filename: (_req, file, cb) => {
      const ts = Date.now();
      const safe = file.originalname.replace(/[^\w.\-]+/g, "_");
      cb(null, `${ts}_${safe}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // guard awal
    fileFilter: async (req, file, cb) => {
      try {
        const policy = await getLatestPolicy();
        const allowed = policy.allowed_mime
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        if (!allowed.includes(file.mimetype)) {
          return cb(new Error(`File type not allowed: ${file.mimetype}`));
        }

        (req as any).__policy = policy;
        return cb(null, true);
      } catch (e: any) {
        return cb(new Error(e?.message ?? "Policy read error"));
      }
    },
  });

  return upload;
}