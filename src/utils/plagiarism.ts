import crypto from "crypto";

export type Fingerprint = { hash: bigint; pos: number }; // pos = index char

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\r\n/g, "\n")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ") // keep letters/numbers, remove punctuation
    .replace(/\s+/g, " ")
    .trim();
}

// rolling-friendly hash (stable)
function hash64(str: string): bigint {
  // sha1 then take first 8 bytes
  const h = crypto.createHash("sha1").update(str).digest();
  let x = 0n;
  for (let i = 0; i < 8; i++) x = (x << 8n) | BigInt(h[i]);
  return x;
}

export function makeKgrams(text: string, k: number): { gram: string; pos: number }[] {
  const t = normalize(text);
  if (t.length < k) return [];
  const grams: { gram: string; pos: number }[] = [];
  for (let i = 0; i <= t.length - k; i++) {
    grams.push({ gram: t.slice(i, i + k), pos: i });
  }
  return grams;
}

/** Winnowing fingerprinting (k-gram hashing + window w + pick minima) */
export function winnow(text: string, k: number, w: number): Fingerprint[] {
  const grams = makeKgrams(text, k);
  if (grams.length === 0) return [];

  const hashes = grams.map((g) => ({ h: hash64(g.gram), pos: g.pos }));

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
      fps.push({ hash: min.h, pos: min.pos });
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

/** Build spans from matching hashes (simple grouping) */
export function buildMatchSpans(
  fpA: Fingerprint[],
  fpB: Fingerprint[],
  k: number
): { doc_span_start: number; doc_span_end: number; src_span_start: number; src_span_end: number; match_score: number; snippet_hash: string }[] {
  const mapB = new Map<string, number[]>(); // hash -> positions
  for (const x of fpB) {
    const key = x.hash.toString();
    const arr = mapB.get(key) ?? [];
    arr.push(x.pos);
    mapB.set(key, arr);
  }

  const matches: { hash: string; aPos: number; bPos: number }[] = [];
  for (const a of fpA) {
    const key = a.hash.toString();
    const bPosList = mapB.get(key);
    if (bPosList && bPosList.length) {
      // pick first position for MVP
      matches.push({ hash: key, aPos: a.pos, bPos: bPosList[0] });
    }
  }

  if (matches.length === 0) return [];

  // sort by doc position
  matches.sort((x, y) => x.aPos - y.aPos);

  // group contiguous by small gap
  const spans: any[] = [];
  let cur = { docStart: matches[0].aPos, docEnd: matches[0].aPos + k, srcStart: matches[0].bPos, srcEnd: matches[0].bPos + k, hash: matches[0].hash };

  for (let i = 1; i < matches.length; i++) {
    const m = matches[i];
    if (m.aPos <= cur.docEnd + k) {
      cur.docEnd = m.aPos + k;
      cur.srcEnd = m.bPos + k;
    } else {
      spans.push(cur);
      cur = { docStart: m.aPos, docEnd: m.aPos + k, srcStart: m.bPos, srcEnd: m.bPos + k, hash: m.hash };
    }
  }
  spans.push(cur);

  const docLen = fpA.length || 1;
  return spans.map((s) => ({
    doc_span_start: s.docStart,
    doc_span_end: s.docEnd,
    src_span_start: s.srcStart,
    src_span_end: s.srcEnd,
    match_score: Math.min(1, (s.docEnd - s.docStart) / (docLen * k)),
    snippet_hash: s.hash,
  }));
}