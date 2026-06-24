/**
 * Pure-local vector embeddings — pre-built at generation time, loaded from
 * src/generated/embeddings.ts. At query time only the query needs embedding
 * (hash-based bag-of-words, ~1ms, zero deps).
 *
 * The corpus vectors are quantized Int16 × SCALE for compact storage.
 * Cosine similarity uses dequantized floats.
 */

import type { DocItem } from "./corpus";
import { DIM, SCALE, VEC_IDS, VEC_B64 } from "../../generated/embeddings";

export interface VectorDb {
  ids: string[];
  /** Dequantized float64 matrix [n_items][DIM] */
  matrix: number[][];
}

let _db: VectorDb | null = null;

export function getVectorDb(): VectorDb {
  if (_db) return _db;

  const raw = new Int16Array(Buffer.from(VEC_B64, "base64").buffer);
  const n = raw.length / DIM;
  const matrix: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(DIM);
    for (let j = 0; j < DIM; j++) {
      row[j] = raw[i * DIM + j]! / SCALE;
    }
    matrix.push(row);
  }
  _db = { ids: [...VEC_IDS], matrix };
  return _db;
}

export function clearVectorDb(): void { _db = null; }

/**
 * Local bag-of-words embedder — hash-based, no model needed.
 * Same algorithm as scripts/generate-embeddings.ts.
 */
export function embed(text: string): number[] {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const vec = new Array(DIM).fill(0);
  for (const t of tokens) {
    let h = 0;
    for (let i = 0; i < t.length; i++) {
      h = ((h << 5) - h) + t.charCodeAt(i);
      h |= 0;
    }
    vec[((h % DIM) + DIM) % DIM]! += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm > 0) for (let i = 0; i < DIM; i++) vec[i]! /= norm;
  return vec;
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
