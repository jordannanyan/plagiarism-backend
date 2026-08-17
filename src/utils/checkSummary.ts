/**
 * Helper untuk membaca `check_result.summary_json`.
 *
 * summary_json versi sekarang:
 * {
 *   params: { id_params, k, w, threshold },
 *   exclude_metadata: boolean,
 *   sources: [{ id_corpus, title, similarity, approx, above_threshold }],
 *   best_similarity: number
 * }
 *
 * Record lama hanya punya `candidates` (berisi estimasi MinHash `approx`,
 * bukan similarity Winnowing sebenarnya), jadi tetap dibaca sebagai fallback
 * dan ditandai `estimated: true`.
 */

export type DetectedSource = {
  id_corpus: number;
  title: string;
  /** 0..1 */
  similarity: number;
  /** true bila similarity >= threshold, artinya span match ikut disimpan */
  above_threshold: boolean;
  /** true bila angkanya estimasi MinHash dari record lama, bukan Jaccard Winnowing */
  estimated?: boolean;
};

function parse(summaryJson: any): any {
  try {
    return typeof summaryJson === "string" ? JSON.parse(summaryJson) : summaryJson;
  } catch {
    return null;
  }
}

/** Default true untuk record lama (yang selalu di-strip sebelum fitur ini ada). */
export function readExcludeMetadata(summaryJson: any): boolean {
  const obj = parse(summaryJson);
  if (obj && typeof obj.exclude_metadata === "boolean") return obj.exclude_metadata;
  return true;
}

/** Threshold (0..1) yang dipakai saat check dijalankan. null bila tidak tercatat. */
export function readThreshold(summaryJson: any): number | null {
  const obj = parse(summaryJson);
  const t = Number(obj?.params?.threshold);
  return Number.isFinite(t) ? t : null;
}

/**
 * Daftar dokumen corpus yang dibandingkan beserta similarity-nya, terurut
 * menurun. Dikembalikan apa adanya termasuk yang di bawah threshold — kalau
 * hanya yang lolos threshold yang ditampilkan, mahasiswa bisa melihat angka
 * similarity tanpa satu pun sumber yang menjelaskan angka itu.
 */
export function readSources(summaryJson: any): DetectedSource[] {
  const obj = parse(summaryJson);
  if (!obj) return [];

  if (Array.isArray(obj.sources)) {
    return obj.sources
      .map((s: any) => ({
        id_corpus: Number(s?.id_corpus),
        title: String(s?.title ?? `Corpus #${s?.id_corpus}`),
        similarity: Number(s?.similarity) || 0,
        above_threshold: Boolean(s?.above_threshold),
      }))
      .filter((s: DetectedSource) => Number.isFinite(s.id_corpus))
      .sort((a: DetectedSource, b: DetectedSource) => b.similarity - a.similarity);
  }

  if (Array.isArray(obj.candidates)) {
    return obj.candidates
      .map((c: any) => ({
        id_corpus: Number(c?.id_corpus),
        title: String(c?.title ?? `Corpus #${c?.id_corpus}`),
        similarity: Number(c?.approx) || 0,
        above_threshold: false,
        estimated: true,
      }))
      .filter((s: DetectedSource) => Number.isFinite(s.id_corpus))
      .sort((a: DetectedSource, b: DetectedSource) => b.similarity - a.similarity);
  }

  return [];
}
