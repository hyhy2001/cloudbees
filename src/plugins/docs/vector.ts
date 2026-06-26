/**
 * Pre-built neural embeddings — loaded from src/generated/embeddings.ts.
 *
 * At query time, embed() calls the configured API embedding endpoint.
 * When no endpoint is configured, vector search is skipped and BM25 handles
 * retrieval alone (96.8% Recall@3).
 *
 * The corpus vectors are quantized Int16 × SCALE for compact storage.
 * Cosine similarity uses dequantized floats.
 */

import type { DocItem } from "./corpus";
import { EMBEDDING_MODEL, EMBEDDING_URL, LM_API_KEY, LM_URL, EMBEDDING_PATH, LM_CLIENT_ID, LM_CLIENT_SECRET } from "./config";
import { DatabricksOAuthProvider, isDatabricksHost } from "./providers/databricks";
import { DIM, SCALE, VEC_IDS, VEC_B64 } from "../../generated/embeddings";

export interface VectorDb {
  ids: string[];
  /** Dequantized float64 matrix [n_items][DIM] */
  matrix: number[][];
}

let _db: VectorDb | null = null;
let _embedFn: ((text: string) => Promise<number[] | null>) | null | false = null;

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
 * Embed a query string into the same vector space as the baked corpus.
 * Returns null when no endpoint is configured or it returns 404 (falls back to BM25).
 * Dimension guard: if the API returns a vector with a different DIM than the corpus,
 * vector search is skipped — re-run generate-embeddings.ts to rebuild.
 */
export async function embed(text: string): Promise<number[] | null> {
  const fn = await getEmbedFn();
  if (!fn) {
    return null;
  }
  const vec = await fn(text);
  if (!vec) return null;
  if (vec.length !== DIM) {
    if (!_warnedDim) {
      process.stderr.write(
        `[bee ask] embedding dim ${vec.length} != baked ${DIM} — vector search disabled (BM25 only). Re-run generate-embeddings.ts.\n`,
      );
      _warnedDim = true;
    }
    return null;
  }
  return vec;
}

let _warnedDim = false;

async function getEmbedFn(): Promise<((text: string) => Promise<number[] | null>) | null> {
  if (_embedFn === false) return null;
  if (_embedFn) return _embedFn;
  try {
    // API-based embedding (Databricks, OpenAI-compatible, etc.)
    if (EMBEDDING_URL) {
      // Auth: static API key wins; else OAuth client-credentials. For Databricks
      // OAuth, reuse DatabricksOAuthProvider's robust token exchange (OIDC
      // discovery + Azure AD fallbacks + caching) rather than a weaker inline
      // copy — otherwise embedding could silently fail on Azure-AD workspaces
      // where chat succeeds, dropping vector search to BM25 with no error.
      let bearer = LM_API_KEY;
      if (!bearer && LM_CLIENT_ID && LM_CLIENT_SECRET && LM_URL) {
        try {
          if (isDatabricksHost(LM_URL)) {
            const provider = new DatabricksOAuthProvider(LM_URL, LM_CLIENT_ID, LM_CLIENT_SECRET, EMBEDDING_MODEL);
            bearer = await provider.token();
          } else {
            const r = await fetch(`${LM_URL.replace(/\/+$/, "")}/oidc/v1/token`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: `grant_type=client_credentials&scope=all-apis&client_id=${LM_CLIENT_ID}&client_secret=${LM_CLIENT_SECRET}`,
              signal: AbortSignal.timeout(10000),
            });
            if (r.ok) bearer = ((await r.json()) as { access_token: string }).access_token;
          }
        } catch { /* fall through — embedding skipped, BM25 still works */ }
      }
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (bearer) headers["authorization"] = `Bearer ${bearer}`;
      const urlCandidates = [EMBEDDING_URL];
      if (!EMBEDDING_URL.endsWith("/v1/embeddings") && LM_URL) {
        urlCandidates.push(`${LM_URL.replace(/\/+$/, "")}${EMBEDDING_PATH}`);
        urlCandidates.push(`${LM_URL.replace(/\/+$/, "")}/serving-endpoints/${encodeURIComponent(EMBEDDING_MODEL)}/invocations`);
      }
      _embedFn = async (t: string) => {
        for (const url of urlCandidates) {
          const r = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ input: t.slice(0, 2048), model: EMBEDDING_MODEL }),
            signal: AbortSignal.timeout(30000),
          });
          if (r.ok) {
            const j = (await r.json()) as { data?: Array<{ embedding: number[] }> };
            return j.data?.[0]?.embedding ?? [];
          }
          if (r.status !== 404) {
            throw new Error(`Embedding API returned ${r.status} at ${url}`);
          }
        }
        // All candidates 404 — embedding endpoint absent, skip vector search.
        return null;
      };
      return _embedFn;
    }
    _embedFn = false;
    return null;
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
  return scores
    .slice(0, topK * 3) // oversample to account for filtered items
    .map((s) => corpus.find((c) => c.id === db.ids[s.idx])!)
    .filter((c): c is DocItem => Boolean(c) && Boolean(c.body?.trim()))
    .slice(0, topK);
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
