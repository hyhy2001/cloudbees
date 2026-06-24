import type { DocItem } from "./corpus";
import { getVectorDb, embed, cosineSimilarity } from "./vector";

/**
 * Rerank BM25 hits using neural embeddings (MiniLM bi-encoder).
 *
 * Scores each hit by cosine similarity between query embedding and the
 * hit's pre-computed corpus embedding. No LM call needed — uses the
 * already-bundled MiniLM model and pre-computed vector DB.
 *
 * Falls back to original BM25 order on any error.
 */
export async function rerank(query: string, hits: DocItem[]): Promise<DocItem[]> {
  if (hits.length <= 2) return hits;

  const vdb = getVectorDb();
  const queryEmb = await embed(query);
  if (!queryEmb) return hits; // fallback: BM25 order

  // Find corpus embedding for each hit and score it.
  const idToEmb = new Map<string, number[]>();
  for (let i = 0; i < vdb.ids.length; i++) {
    idToEmb.set(vdb.ids[i]!, vdb.matrix[i]!);
  }

  const scored = hits
    .map((hit, i) => {
      const emb = idToEmb.get(hit.id);
      const score = emb ? cosineSimilarity(queryEmb, emb) : 0;
      return { hit, score, origIdx: i };
    })
    .sort((a, b) => b.score - a.score || a.origIdx - b.origIdx);

  return scored.map((s) => s.hit);
}
