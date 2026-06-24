/**
 * Pre-built neural embeddings — loaded from src/generated/embeddings.ts.
 *
 * At query time, embed() lazily loads @xenova/transformers + MiniLM model
 * for neural query embedding. The model files are bundled in the binary
 * via src/generated/embedding-model.ts and extracted to a temp directory
 * at startup — no download needed, works fully offline in a single binary.
 *
 * If @xenova/transformers is not available (dev who didn't bun install),
 * getEmbedFn() returns null and vector search is skipped — BM25 handles
 * retrieval alone (96.8% Recall@3).
 *
 * The corpus vectors are quantized Int16 × SCALE for compact storage.
 * Cosine similarity uses dequantized floats.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Directory of the running binary/script — model files go right next to it.
function beeDir(): string {
  // Compiled binary: process.execPath → /path/to/bee
  // Dev mode: import.meta.url → /path/to/src/plugins/docs/vector.ts
  const p = "execPath" in process ? process.execPath : fileURLToPath(import.meta.url);
  return dirname(p);
}
import type { DocItem } from "./corpus";
import { DIM, SCALE, VEC_IDS, VEC_B64 } from "../../generated/embeddings";
import { MODEL_FILES } from "../../generated/embedding-model";

export interface VectorDb {
  ids: string[];
  /** Dequantized float64 matrix [n_items][DIM] */
  matrix: number[][];
}

let _db: VectorDb | null = null;
let _embedFn: ((text: string) => Promise<number[]>) | null | false = null;

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

export function clearVectorDb(): void { _db = null; _embedFn = null; }

/**
 * Embed a query string in the same neural space as the corpus.
 * Returns null when @xenova/transformers is unavailable (caller should
 * skip vector search and fall back to BM25-only).
 */
export async function embed(text: string): Promise<number[] | null> {
  const fn = await getEmbedFn();
  if (!fn) return null;
  return fn(text);
}

let _modelDir: string | null = null;

async function getEmbedFn(): Promise<((text: string) => Promise<number[]>) | null> {
  if (_embedFn === false) return null;
  if (_embedFn) return _embedFn;
  try {
    // Extract bundled model files next to the bee binary (persistent, once).
    if (!_modelDir) {
      _modelDir = join(beeDir(), ".bee-models");
      const marker = join(_modelDir, "Xenova", "all-MiniLM-L6-v2", "onnx", "model_quantized.onnx");
      if (!existsSync(marker)) {
        for (const [relPath, b64] of Object.entries(MODEL_FILES)) {
          const full = join(_modelDir, relPath);
          mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
          writeFileSync(full, Buffer.from(b64, "base64"));
        }
      }
    }

    const { pipeline, env } = await import("@xenova/transformers");
    env.cacheDir = _modelDir;
    env.localModelPath = _modelDir;

    const extract = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      quantized: true,
    });
    _embedFn = async (t: string) => {
      const result = await extract(t.slice(0, 512), { pooling: "mean", normalize: true });
      return Array.from(result.data) as number[];
    };
    return _embedFn;
} catch (e) {
    _embedFn = false; // permanent fail — don't retry
    return null;
  }
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
