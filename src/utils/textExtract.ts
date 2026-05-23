import fs from "fs";
import mammoth from "mammoth";

type PDFParseResult = { text?: string };

async function extractPdfText(filePath: string): Promise<string> {
  const mod: any = await import("pdf-parse");

  const PDFParse = mod?.PDFParse ?? mod?.default?.PDFParse ?? mod?.default;
  if (!PDFParse) {
    const keys = Object.keys(mod ?? {});
    const defKeys = Object.keys(mod?.default ?? {});
    throw new Error(`PDFParse class not found. keys=${keys.join(",")} defaultKeys=${defKeys.join(",")}`);
  }

  const dataBuffer = fs.readFileSync(filePath);
  const data = new Uint8Array(dataBuffer);

  const parser = new PDFParse({ data });
  const result: PDFParseResult = await parser.getText();
  return result.text ?? "";
}

export async function extractTextFromFile(filePath: string, mimeType: string): Promise<string> {
  if (mimeType === "text/plain") {
    return fs.readFileSync(filePath, "utf-8");
  }

  if (mimeType === "application/pdf") {
    return await extractPdfText(filePath);
  }

  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value ?? "";
  }

  return "";
}

export function normalizeTextBasic(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Hapus bagian yang TIDAK ikut dicek oleh sistem:
 *  - Header (judul, nama penulis, nama universitas, afiliasi) → semua teks
 *    sebelum heading body seperti ABSTRAK/ABSTRACT/PENDAHULUAN/LATAR BELAKANG/
 *    TINJAUAN PUSTAKA.
 *  - Daftar Pustaka / References / Bibliography → mulai heading sampai akhir.
 *
 * Jika heading tidak ditemukan, bagian itu tidak dipotong (konservatif).
 *
 * Return `cleanedText` yang langsung dipakai untuk fingerprinting. Original text
 * tetap utuh utk preview.
 */
export type CheckableSection = {
  cleanedText: string;
  /** offset awal `cleanedText` di teks original (chars) */
  startOffset: number;
  /** offset akhir `cleanedText` di teks original (chars, exclusive) */
  endOffset: number;
  /** bagian-bagian yang dibuang */
  removed: Array<{ start: number; end: number; reason: string }>;
};

const BODY_START_PATTERNS: RegExp[] = [
  /\bABSTRA[KC]\b/i,
  /\bABSTRACT\b/i,
  /\bPENDAHULUAN\b/i,
  /\bLATAR\s+BELAKANG\b/i,
  /\bINTRODUCTION\b/i,
  /\bTINJAUAN\s+PUSTAKA\b/i,
];

const REFS_START_PATTERNS: RegExp[] = [
  /\bDAFTAR\s+PUSTAKA\b/i,
  /\bDAFTAR\s+REFERENSI\b/i,
  /\bREFERENSI\b/i,
  /\bREFERENCES\b/i,
  /\bBIBLIOGRAPHY\b/i,
];

function firstMatch(text: string, patterns: RegExp[], fromIndex = 0): number {
  let best = -1;
  for (const p of patterns) {
    p.lastIndex = 0;
    const sub = text.slice(fromIndex);
    const m = p.exec(sub);
    if (m) {
      const idx = fromIndex + m.index;
      if (best < 0 || idx < best) best = idx;
    }
  }
  return best;
}

export function stripUncheckableSections(text: string): CheckableSection {
  if (!text) {
    return { cleanedText: "", startOffset: 0, endOffset: 0, removed: [] };
  }

  const removed: Array<{ start: number; end: number; reason: string }> = [];

  // body start
  let bodyStart = firstMatch(text, BODY_START_PATTERNS, 0);
  if (bodyStart < 0) bodyStart = 0;
  if (bodyStart > 0) {
    removed.push({ start: 0, end: bodyStart, reason: "header (judul/penulis/universitas)" });
  }

  // references start, cari setelah bodyStart
  let refsStart = firstMatch(text, REFS_START_PATTERNS, bodyStart);
  if (refsStart < 0) refsStart = text.length;
  if (refsStart < text.length) {
    removed.push({ start: refsStart, end: text.length, reason: "daftar pustaka" });
  }

  const cleanedText = text.slice(bodyStart, refsStart);
  return {
    cleanedText,
    startOffset: bodyStart,
    endOffset: refsStart,
    removed,
  };
}