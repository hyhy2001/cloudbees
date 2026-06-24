import { LM_URL, LM_MODEL } from "./config";
import type { DocItem } from "./corpus";

const EMBED_URL = (LM_URL ?? "http://127.0.0.1:11434").replace("/v1/chat/completions", "");
const EMBED_MODEL = LM_MODEL ?? "qwen2.5-coder-3b-q4_k_m.gguf";

export interface VectorDb {
  ids: string[];
  matrix: number[][];
}

let _db: VectorDb | null = null;

/**
 * Pre-compute embeddings for all command/doc items in the corpus.
 * Called once at startup; cached globally.
 */
export async function buildVectorDb(corpus: DocItem[]): Promise<VectorDb> {
  if (_db) return _db;

  const ids: string[] = [];
  const matrix: number[][] = [];

  for (const item of corpus) {
    const text = [item.title, item.description, item.body].filter(Boolean).join(" ").slice(0, 512);
    try {
      const emb = await embed(text);
      ids.push(item.id);
      matrix.push(emb);
    } catch {
      // skip items that fail to embed
    }
  }

  _db = { ids, matrix };
  return _db;
}

export function clearVectorDb(): void { _db = null; }

export async function embed(text: string): Promise<number[]> {
  const r = await fetch(`${EMBED_URL}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: text,
      encoding_format: "float",
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`embedding HTTP ${r.status}`);
  const j = (await r.json()) as { data: { embedding: number[] }[] };
  return j.data[0]!.embedding;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Search vector DB by cosine similarity. Returns top-K items.
 */
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
export function rrfFusion(
  bm25: DocItem[],
  vector: DocItem[],
  k = 60,
): DocItem[] {
  const scores = new Map<string, number>();

  bm25.forEach((item, i) => {
    scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + i));
  });
  vector.forEach((item, i) => {
    scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + i));
  });

  const seen = new Set<string>();
  const fused: DocItem[] = [];
  // Interleave by highest score from either list
  for (const [id] of [...scores.entries()].sort((a, b) => b[1] - a[1])) {
    if (seen.has(id)) continue;
    seen.add(id);
    const item = [...bm25, ...vector].find((c) => c.id === id);
    if (item) fused.push(item);
  }
  return fused;
}
