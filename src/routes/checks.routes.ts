import { Router } from "express";
import fs from "fs";
import { db } from "../db";
import { auth, AuthedRequest } from "../middleware/auth";
import { requireRole } from "../middleware/role";
import {
  winnow,
  fingerprintSimilarity,
  minhashSignature,
  lshBuckets,
  estimateMinhashSim,
  buildMatchSpans,
} from "../utils/plagiarism";

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
  } catch { }
}

async function getActiveParams() {
  const [rows] = await db.query<any[]>(
    `
    SELECT id_params, k, w, base, threshold, active_from, active_to
    FROM algoritma_params
    WHERE (active_to IS NULL OR active_to > NOW()) AND active_from <= NOW()
    ORDER BY active_from DESC, id_params DESC
    LIMIT 1
    `
  );
  return rows[0] ?? null;
}

function readTextSafe(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

/**
 * POST /api/checks
 * body: { doc_id: number, max_candidates?: number }
 */
router.post("/", auth, requireRole("mahasiswa", "dosen"), async (req: AuthedRequest, res) => {
  const ip = getClientIp(req);

  const docId = Number(req.body?.doc_id);
  const maxCandidates = Math.min(Number(req.body?.max_candidates ?? 10), 50);

  if (!Number.isFinite(docId) || docId <= 0) {
    return res.status(400).json({ ok: false, message: "doc_id is required" });
  }

  const params = await getActiveParams();
  if (!params) {
    return res.status(400).json({ ok: false, message: "No active algoritma_params found" });
  }

  const k = Number(params.k);
  const w = Number(params.w);
  const threshold = Number(params.threshold);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // get user doc
    const [docRows] = await conn.query<any[]>(
      `SELECT id_doc, owner_user_id, title, path_text
       FROM user_document
       WHERE id_doc = ? AND owner_user_id = ?
       LIMIT 1`,
      [docId, req.user!.id]
    );
    const doc = docRows[0];
    if (!doc) {
      await conn.rollback();
      return res.status(404).json({ ok: false, message: "Document not found" });
    }

    // insert check_request
    const [insCheck] = await conn.query<any>(
      `INSERT INTO check_request (requested_by, doc_id, params_id, status, queued_at, started_at)
       VALUES (?, ?, ?, 'processing', NOW(), NOW())`,
      [req.user!.id, docId, params.id_params]
    );
    const checkId = insCheck.insertId as number;

    await audit({
      user_id: req.user!.id,
      action: "CREATE_CHECK_REQUEST",
      entity: "check_request",
      entity_id: checkId,
      ip_addr: ip,
    });

    // load doc text
    const docText = readTextSafe(doc.path_text);
    if (!docText || docText.trim().length < k) {
      await conn.query(
        `UPDATE check_request SET status='failed', finished_at=NOW() WHERE id_check=?`,
        [checkId]
      );
      await conn.commit();
      return res.status(400).json({ ok: false, message: "Document text is empty or too short to check" });
    }

    // load corpus active
    const [corpusRows] = await conn.query<any[]>(
      `SELECT id_corpus, title, path_text
       FROM corpus_document
       WHERE is_active = 1 AND path_text IS NOT NULL
       ORDER BY id_corpus DESC`
    );

    // --- MinHash + LSH candidate selection ---
    const sigDoc = minhashSignature(docText, k, 100);
    const bucketsDoc = new Set(lshBuckets(sigDoc, 20));

    const scoredCandidates: { id_corpus: number; title: string; approx: number }[] = [];

    for (const c of corpusRows) {
      const cText = readTextSafe(c.path_text);
      if (!cText || cText.trim().length < k) continue;

      const sigC = minhashSignature(cText, k, 100);
      const bucketsC = lshBuckets(sigC, 20);

      // if share at least 1 bucket, candidate
      let share = false;
      for (const b of bucketsC) {
        if (bucketsDoc.has(b)) { share = true; break; }
      }
      if (!share) continue;

      const approx = estimateMinhashSim(sigDoc, sigC);
      scoredCandidates.push({ id_corpus: c.id_corpus, title: c.title, approx });
    }

    scoredCandidates.sort((a, b) => b.approx - a.approx);
    const candidates = scoredCandidates.slice(0, maxCandidates);

    // --- Winnowing verification on candidates ---
    const fpDoc = winnow(docText, k, w);

    const matchesToInsert: any[] = [];
    let bestSim = 0;

    for (const cand of candidates) {
      const c = corpusRows.find((x) => x.id_corpus === cand.id_corpus);
      if (!c) continue;

      const cText = readTextSafe(c.path_text);
      const fpC = winnow(cText, k, w);

      const sim = fingerprintSimilarity(fpDoc, fpC); // 0..1
      if (sim > bestSim) bestSim = sim;

      if (sim >= threshold) {
        const spans = buildMatchSpans(fpDoc, fpC, k);
        // simpan span-span sebagai baris check_match (MVP: insert beberapa span)
        for (const s of spans.slice(0, 50)) {
          matchesToInsert.push({
            source_type: "corpus",
            source_id: cand.id_corpus,
            doc_span_start: s.doc_span_start,
            doc_span_end: s.doc_span_end,
            src_span_start: s.src_span_start,
            src_span_end: s.src_span_end,
            match_score: sim,
            snippet_hash: s.snippet_hash,
          });
        }
      }
    }

    const similarityPercent = Math.round(bestSim * 10000) / 100; // 2 decimals

    const summary = {
      params: { id_params: params.id_params, k, w, threshold },
      candidates: candidates.map((x) => ({ id_corpus: x.id_corpus, title: x.title, approx: x.approx })),
      best_similarity: bestSim,
    };

    // insert check_result
    const [insRes] = await conn.query<any>(
      `INSERT INTO check_result (check_id, similarity, report_path, summary_json, created_at)
       VALUES (?, ?, NULL, ?, NOW())`,
      [checkId, similarityPercent, JSON.stringify(summary)]
    );
    const resultId = insRes.insertId as number;

    // insert check_match
    if (matchesToInsert.length) {
      for (const m of matchesToInsert) {
        await conn.query(
          `INSERT INTO check_match
            (result_id, source_type, source_id, doc_span_start, doc_span_end, src_span_start, src_span_end, match_score, snippet_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            resultId,
            m.source_type,
            m.source_id,
            m.doc_span_start,
            m.doc_span_end,
            m.src_span_start,
            m.src_span_end,
            m.match_score,
            m.snippet_hash,
          ]
        );
      }
    }

    // done
    await conn.query(
      `UPDATE check_request SET status='done', finished_at=NOW() WHERE id_check=?`,
      [checkId]
    );

    await conn.commit();

    await audit({
      user_id: req.user!.id,
      action: "CHECK_COMPLETED",
      entity: "check_result",
      entity_id: resultId,
      ip_addr: ip,
    });

    return res.status(201).json({
      ok: true,
      check_id: checkId,
      result_id: resultId,
      similarity: similarityPercent,
      threshold,
      candidates_count: candidates.length,
      matches_inserted: matchesToInsert.length,
    });
  } catch (e: any) {
    await conn.rollback();
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  } finally {
    conn.release();
  }
});

/**
 * GET /api/checks
 * list checks milik user
 */
router.get("/", auth, requireRole("mahasiswa", "dosen"), async (req: AuthedRequest, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    const [rows] = await db.query<any[]>(
      `
      SELECT
        cr.id_check, cr.status, cr.queued_at, cr.started_at, cr.finished_at,
        ud.id_doc, ud.title AS doc_title,
        ar.id_result, ar.similarity
      FROM check_request cr
      JOIN user_document ud ON ud.id_doc = cr.doc_id
      LEFT JOIN check_result ar ON ar.check_id = cr.id_check
      WHERE cr.requested_by = ?
      ORDER BY cr.id_check DESC
      LIMIT ? OFFSET ?
      `,
      [req.user!.id, limit, offset]
    );

    const [countRows] = await db.query<any[]>(
      `SELECT COUNT(*) AS total FROM check_request WHERE requested_by = ?`,
      [req.user!.id]
    );

    return res.json({ ok: true, total: countRows?.[0]?.total ?? 0, limit, offset, rows });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

/**
 * GET /api/checks/:id
 * detail result + matches + (optional) preview highlights
 */
router.get("/:id", auth, requireRole("mahasiswa", "dosen"), async (req: AuthedRequest, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, message: "Invalid check id" });

    const [checkRows] = await db.query<any[]>(
      `
      SELECT cr.*, ud.title AS doc_title, ud.path_text
      FROM check_request cr
      JOIN user_document ud ON ud.id_doc = cr.doc_id
      WHERE cr.id_check = ? AND cr.requested_by = ?
      LIMIT 1
      `,
      [id, req.user!.id]
    );
    const check = checkRows[0];
    if (!check) return res.status(404).json({ ok: false, message: "Check not found" });

    const [resRows] = await db.query<any[]>(
      `SELECT id_result, similarity, report_path, summary_json, created_at
       FROM check_result WHERE check_id = ? LIMIT 1`,
      [id]
    );
    const result = resRows[0] ?? null;

    let matches: any[] = [];
    if (result?.id_result) {
      const [mRows] = await db.query<any[]>(
        `
        SELECT
          cm.*,
          cd.title AS corpus_title
        FROM check_match cm
        LEFT JOIN corpus_document cd ON cd.id_corpus = cm.source_id
        WHERE cm.result_id = ?
        ORDER BY cm.match_score DESC, cm.id_match ASC
        `,
        [result.id_result]
      );
      matches = mRows;
    }

    // optional: return doc preview text for highlighting (first 8000 chars)
    const preview = (req.query.preview as string | undefined) !== "0";
    let doc_preview_text: string | null = null;
    if (preview && check.path_text) {
      const t = readTextSafe(check.path_text);
      doc_preview_text = t.slice(0, 8000);
    }

    return res.json({ ok: true, check, result, matches, doc_preview_text });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Server error" });
  }
});

/**
 * GET /api/checks/:id/report
 * Stub dulu (nanti generate PDF report_path)
 */
router.get("/:id/report", auth, requireRole("mahasiswa", "dosen"), async (_req: AuthedRequest, res) => {
  return res.status(501).json({ ok: false, message: "Report not implemented yet" });
});

export default router;