/**
 * Pure-local vector embeddings — no model server, no HTTP calls, no deps.
 *
 * Uses a hash-based bag-of-words embedding where each word maps to a
 * random dimension via a hash function. The same algorithm is used for
 * both corpus items (pre-computed at startup) and the query (on every ask).
 *
 * This is NOT a neural embedding — it trades accuracy for zero dependencies.
 * With a 2048-dim space and ~200 unique words per item, it's good enough
 * to distinguish CLI commands from each other (which is all we need for
 * RRF fusion with BM25).
 */

import type { DocItem } from "./corpus";

const DIM = 2048;

export interface VectorDb {
  ids: string[];
  matrix: number[][];
}

let _db: VectorDb | null = null;

/** Build the vector DB from the corpus at startup. */
export function buildVectorDb(corpus: DocItem[]): VectorDb {
  if (_db) return _db;
  const ids: string[] = [];
  const matrix: number[][] = [];
  for (const item of corpus) {
    const text = [item.title, item.description, item.body].filter(Boolean).join(" ");
    ids.push(item.id);
    matrix.push(embed(text));
  }
  _db = { ids, matrix };
  return _db;
}

/** Clear cached DB (for testing). */
export function clearVectorDb(): void { _db = null; }

/** Local bag-of-words embedder — hash-based, no model needed. */
export function embed(text: string): number[] {
  const tokens = tokenize(text);
  const vec = new Array(DIM).fill(0);
  if (tokens.length === 0) return vec;
  for (const t of tokens) {
    let h = 0;
    for (let i = 0; i < t.length; i++) {
      h = ((h << 5) - h) + t.charCodeAt(i);
      h |= 0;
    }
    const idx = ((h % DIM) + DIM) % DIM;
    vec[idx]! += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm > 0) for (let i = 0; i < DIM; i++) vec[i]! /= norm;
  return vec;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Search vector DB by cosine similarity. Returns top-K items. */
export function searchVector(queryEmb: number[], db: VectorDb, corpus: DocItem[], topK: number): DocItem[] {
  const scores: { idx: number; score: number }[] = [];
  for (let i = 0; i < db.ids.length; i++) {
    scores.push({ idx: i, score: cosineSimilarity(queryEmb, db.matrix[i]!) });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, topK).map((s) => corpus.find((c) => c.id === db.ids[s.idx])!).filter(Boolean);
}

/**
 * Reciprocal Rank Fusion: merge BM25 and vector results.
 * k = 60 (standard RRF constant).
 */
export function rrfFusion(bm25: DocItem[], vector: DocItem[], k = 60): DocItem[] {
  const scores = new Map<string, number>();
  bm25.forEach((item, i) => { scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + i)); });
  vector.forEach((item, i) => { scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + i)); });
  const seen = new Set<string>();
  const fused: DocItem[] = [];
  for (const [id] of [...scores.entries()].sort((a, b) => b[1] - a[1])) {
    if (seen.has(id)) continue;
    seen.add(id);
    const item = [...bm25, ...vector].find((c) => c.id === id);
    if (item) fused.push(item);
  }
  return fused;
}
