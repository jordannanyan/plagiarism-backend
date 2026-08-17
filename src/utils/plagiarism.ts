import crypto from "crypto";

export type Fingerprint = {
  hash: bigint;
  /** index karakter pada teks TERNORMALISASI */
  pos: number;
  /** offset awal k-gram pada teks ASLI (untuk highlight) */
  srcStart: number;
  /** offset akhir k-gram pada teks ASLI, exclusive */
  srcEnd: number;
};

type NormalizedText = {
  text: string;
  /** mapStart[i] = offset awal karakter ke-i pada teks asli */
  mapStart: number[];
  /** mapEnd[i] = offset akhir (exclusive) karakter ke-i pada teks asli */
  mapEnd: number[];
};

/**
 * Normalisasi teks sekaligus mencatat asal setiap karakter pada teks asli.
 *
 * Hasil `text` identik dengan normalisasi lama (lowercase, tanda baca jadi
 * pemisah, deretan pemisah dipadatkan jadi satu spasi, di-trim). Bedanya kini
 * ada `map` supaya posisi fingerprint bisa dikembalikan ke koordinat teks asli.
 * Tanpa peta ini highlight akan meleset, karena setiap tanda baca yang dibuang
 * dan setiap deretan spasi yang dipadatkan menggeser posisi sesudahnya.
 */
function normalizeWithMap(input: string): NormalizedText {
  const chars: string[] = [];
  const mapStart: number[] = [];
  const mapEnd: number[] = [];

  let pendingSeparator = false;
  let prevWordEnd = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const isWordChar = /[\p{L}\p{N}]/u.test(ch);

    if (!isWordChar) {
      // whitespace maupun tanda baca sama-sama diperlakukan sebagai pemisah
      if (chars.length > 0) pendingSeparator = true;
      continue;
    }

    if (pendingSeparator) {
      // Satu spasi sintetis mewakili seluruh deretan pemisah. Awalnya dipetakan
      // ke awal kata berikutnya dan akhirnya ke akhir kata sebelumnya, supaya
      // span yang diawali/diakhiri spasi berhenti tepat di batas kata dan tidak
      // menyorot potongan whitespace atau satu huruf kata tetangga.
      chars.push(" ");
      mapStart.push(i);
      mapEnd.push(prevWordEnd);
      pendingSeparator = false;
    }

    // toLowerCase bisa menghasilkan lebih dari satu karakter untuk sebagian
    // huruf, jadi setiap keluaran dipetakan ke indeks sumber yang sama.
    for (const c of ch.toLowerCase()) {
      chars.push(c);
      mapStart.push(i);
      mapEnd.push(i + 1);
    }
    prevWordEnd = i + 1;
  }

  return { text: chars.join(""), mapStart, mapEnd };
}

// rolling-friendly hash (stable)
function hash64(str: string): bigint {
  // sha1 then take first 8 bytes
  const h = crypto.createHash("sha1").update(str).digest();
  let x = 0n;
  for (let i = 0; i < 8; i++) x = (x << 8n) | BigInt(h[i]);
  // Convert unsigned 64-bit to signed 64-bit to fit MySQL BIGINT column
  if (x >= 0x8000000000000000n) x -= 0x10000000000000000n;
  return x;
}

export type Kgram = {
  gram: string;
  /** index pada teks ternormalisasi */
  pos: number;
  /** rentang k-gram ini pada teks asli */
  srcStart: number;
  srcEnd: number;
};

export function makeKgrams(text: string, k: number): Kgram[] {
  const { text: t, mapStart, mapEnd } = normalizeWithMap(text);
  if (t.length < k) return [];
  const grams: Kgram[] = [];
  for (let i = 0; i <= t.length - k; i++) {
    const srcStart = mapStart[i];
    grams.push({
      gram: t.slice(i, i + k),
      pos: i,
      srcStart,
      // k-gram yang seluruhnya spasi (hanya mungkin saat k = 1) bisa membuat
      // end < start, jadi dijaga agar rentangnya tidak terbalik.
      srcEnd: Math.max(mapEnd[i + k - 1], srcStart),
    });
  }
  return grams;
}

/** Winnowing fingerprinting (k-gram hashing + window w + pick minima) */
export function winnow(text: string, k: number, w: number): Fingerprint[] {
  const grams = makeKgrams(text, k);
  if (grams.length === 0) return [];

  const hashes = grams.map((g) => ({
    h: hash64(g.gram),
    pos: g.pos,
    srcStart: g.srcStart,
    srcEnd: g.srcEnd,
  }));

  const windowSize = Math.max(1, w);
  const fps: Fingerprint[] = [];

  let lastPickedPos = -1;
  let lastPickedHash: bigint | null = null;

  for (let i = 0; i <= hashes.length - windowSize; i++) {
    let min = hashes[i];
    for (let j = i; j < i + windowSize; j++) {
      const cur = hashes[j];
      if (cur.h < min.h) min = cur;
    }

    // winnowing rule: avoid duplicates
    if (min.pos !== lastPickedPos || min.h !== lastPickedHash) {
      fps.push({ hash: min.h, pos: min.pos, srcStart: min.srcStart, srcEnd: min.srcEnd });
      lastPickedPos = min.pos;
      lastPickedHash = min.h;
    }
  }

  // unique by (hash,pos) already mostly, but ensure stable
  return fps;
}

/** Jaccard similarity of fingerprint hashes */
export function fingerprintSimilarity(a: Fingerprint[], b: Fingerprint[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a.map((x) => x.hash.toString()));
  const setB = new Set(b.map((x) => x.hash.toString()));

  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;

  const union = setA.size + setB.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

/** --- MinHash + LSH (candidate selection) --- */

function modBig(x: bigint, m: bigint) {
  const r = x % m;
  return r >= 0n ? r : r + m;
}

const PRIME = 2305843009213693951n; // 2^61 - 1 (prime-ish, ok for hashing)

function hashToInt61(h: bigint): bigint {
  return modBig(h, PRIME);
}

export function minhashSignature(text: string, k: number, numPerm = 100): bigint[] {
  const grams = makeKgrams(text, k);
  const set = new Set<string>();
  for (const g of grams) set.add(hashToInt61(hash64(g.gram)).toString());
  const items = Array.from(set, (s) => BigInt(s));
  if (items.length === 0) return Array(numPerm).fill(PRIME);

  // deterministic a,b
  const sig: bigint[] = [];
  for (let i = 0; i < numPerm; i++) {
    const a = BigInt(1 + (i * 7919) % 100000);
    const b = BigInt(1 + (i * 104729) % 100000);
    let min = PRIME;
    for (const x of items) {
      const v = modBig(a * x + b, PRIME);
      if (v < min) min = v;
    }
    sig.push(min);
  }
  return sig;
}

export function lshBuckets(sig: bigint[], bands = 20): string[] {
  // rows per band = sig.length / bands
  const r = Math.floor(sig.length / bands);
  if (r <= 0) return [];
  const buckets: string[] = [];
  for (let b = 0; b < bands; b++) {
    const start = b * r;
    const end = start + r;
    const slice = sig.slice(start, end).map((x) => x.toString()).join("-");
    const bandHash = crypto.createHash("sha1").update(`${b}:${slice}`).digest("hex");
    buckets.push(`${b}:${bandHash}`);
  }
  return buckets;
}

export function estimateMinhashSim(sigA: bigint[], sigB: bigint[]): number {
  if (sigA.length === 0 || sigB.length === 0) return 0;
  const n = Math.min(sigA.length, sigB.length);
  let same = 0;
  for (let i = 0; i < n; i++) if (sigA[i] === sigB[i]) same++;
  return same / n;
}

/**
 * Build spans from matching hashes (simple grouping).
 *
 * Penggabungan span diputuskan pada koordinat TERNORMALISASI (di situlah jarak
 * "k karakter" punya arti), tetapi rentang yang dikembalikan sudah dalam
 * koordinat teks ASLI supaya bisa langsung dipakai untuk highlight.
 */
export function buildMatchSpans(
  fpA: Fingerprint[],
  fpB: Fingerprint[],
  k: number
): { doc_span_start: number; doc_span_end: number; src_span_start: number; src_span_end: number; match_score: number; snippet_hash: string }[] {
  const mapB = new Map<string, { start: number; end: number }[]>(); // hash -> rentang pada teks asli B
  for (const x of fpB) {
    const key = x.hash.toString();
    const arr = mapB.get(key) ?? [];
    arr.push({ start: x.srcStart, end: x.srcEnd });
    mapB.set(key, arr);
  }

  const matches: {
    hash: string;
    aPos: number; // ternormalisasi, untuk grouping
    aStart: number;
    aEnd: number; // teks asli
    bStart: number;
    bEnd: number;
  }[] = [];
  for (const a of fpA) {
    const key = a.hash.toString();
    const bList = mapB.get(key);
    if (bList && bList.length) {
      // pick first position for MVP
      matches.push({
        hash: key,
        aPos: a.pos,
        aStart: a.srcStart,
        aEnd: a.srcEnd,
        bStart: bList[0].start,
        bEnd: bList[0].end,
      });
    }
  }

  if (matches.length === 0) return [];

  // sort by doc position
  matches.sort((x, y) => x.aPos - y.aPos);

  // group contiguous by small gap
  type Span = {
    posStart: number;
    posEnd: number;
    docStart: number;
    docEnd: number;
    srcStart: number;
    srcEnd: number;
    hash: string;
  };

  const spans: Span[] = [];
  const first = matches[0];
  let cur: Span = {
    posStart: first.aPos,
    posEnd: first.aPos + k,
    docStart: first.aStart,
    docEnd: first.aEnd,
    srcStart: first.bStart,
    srcEnd: first.bEnd,
    hash: first.hash,
  };

  for (let i = 1; i < matches.length; i++) {
    const m = matches[i];
    if (m.aPos <= cur.posEnd + k) {
      cur.posEnd = m.aPos + k;
      cur.docEnd = Math.max(cur.docEnd, m.aEnd);
      cur.srcEnd = Math.max(cur.srcEnd, m.bEnd);
    } else {
      spans.push(cur);
      cur = {
        posStart: m.aPos,
        posEnd: m.aPos + k,
        docStart: m.aStart,
        docEnd: m.aEnd,
        srcStart: m.bStart,
        srcEnd: m.bEnd,
        hash: m.hash,
      };
    }
  }
  spans.push(cur);

  const docLen = fpA.length || 1;
  return spans.map((s) => ({
    doc_span_start: s.docStart,
    doc_span_end: s.docEnd,
    src_span_start: s.srcStart,
    src_span_end: s.srcEnd,
    // skor dihitung dari panjang ternormalisasi supaya tidak terpengaruh
    // banyaknya tanda baca / spasi pada teks asli
    match_score: Math.min(1, (s.posEnd - s.posStart) / (docLen * k)),
    snippet_hash: s.hash,
  }));
}