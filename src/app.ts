import express from "express";
import cors from "cors";
import { db } from "./db";
import authRoutes from "./routes/auth.routes";
import adminUsersRoutes from "./routes/admin.users.routes";
import adminPolicyRoutes from "./routes/admin.policy.routes";
import adminParamsRoutes from "./routes/admin.params.routes";
import corpusRoutes from "./routes/corpus.routes";
import documentsRoutes from "./routes/documents.routes";
import checksRoutes from "./routes/checks.routes";
import verificationRoutes from "./routes/verification.routes";
import adminAuditRoutes from "./routes/admin.audit.routes";


const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "plagiarism-backend" });
});

app.get("/db-test", async (_req, res) => {
  try {
    const [rows] = await db.query("SELECT 1 AS ping");
    res.json({ ok: true, rows });
  } catch (e: any) {
    res.status(500).json({ ok: false, message: e?.message ?? "DB error" });
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/admin/users", adminUsersRoutes);
app.use("/api/admin/policy", adminPolicyRoutes);
app.use("/api/admin/params", adminParamsRoutes);
app.use("/api/corpus", corpusRoutes);
app.use("/api/documents", documentsRoutes);
app.use("/api/checks", checksRoutes);
app.use("/api/verification", verificationRoutes);
app.use("/api/admin/audit", adminAuditRoutes);

export default app;