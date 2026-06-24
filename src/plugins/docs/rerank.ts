import type { DocItem } from "./corpus";

/**
 * Rerank BM25 hits by asking the LM to score each hit's relevance to the query.
 *
 * BM25 Recall@3 is already 96.7%, but Recall@1 is only 75% — the right hit is
 * in the top-3 but not at rank 1. A lightweight LM scoring pass pushes the
 * most relevant hit to the top before prompt assembly.
 *
 * Strategy: batch-score up to 15 hits in a single LM call. The prompt asks
 * for a 1-5 rating per hit. Fall back to original BM25 order on error or
 * unparseable output.
 */

const SCORE_PATTERN = /^[\d.,\s]+$/;

export async function rerank(
  query: string,
  hits: DocItem[],
  generate: (prompt: string) => Promise<string>,
): Promise<DocItem[]> {
  if (hits.length <= 2) return hits; // nothing to reorder

  const batch = hits.slice(0, 15); // score up to 15 items
  const prompt = buildScorePrompt(query, batch);

  let raw: string;
  try {
    raw = await generate(prompt);
  } catch {
    return hits; // fall back to BM25 order
  }

  const scores = parseScores(raw, batch.length);
  if (!scores) return hits;

  // Pair each hit with its score, sort descending, preserve original order on tie.
  const scored: { hit: DocItem; score: number; origIdx: number }[] = batch.map((hit, i) => ({
    hit,
    score: scores[i] ?? 0,
    origIdx: i,
  }));
  scored.sort((a, b) => b.score - a.score || a.origIdx - b.origIdx);

  // Concatenate scored (re-ranked) + unscored (remaining, keep BM25 order).
  const reRanked = scored.map((s) => s.hit);
  const remaining = hits.slice(batch.length);
  return [...reRanked, ...remaining];
}

function buildScorePrompt(query: string, items: DocItem[]): string {
  const rows = items
    .map((item, i) => {
      const title = item.title || item.id;
      const desc = (item.description || item.body || "").slice(0, 120).replace(/\s+/g, " ").trim();
      return `${i + 1}. ${title}: ${desc}`;
    })
    .join("\n");

  return [
    `Question: "${query}"`,
    "",
    "Rate how relevant each command/info below is to answering that question.",
    "Rate 1 (not relevant) to 5 (very relevant). Be strict — only 4-5 if the item clearly answers.",
    "",
    rows,
    "",
    "Return ONLY the scores as comma-separated numbers, nothing else:",
  ].join("\n");
}

function parseScores(raw: string, expected: number): number[] | null {
  const cleaned = raw
    .replace(/\s+/g, "")
    .replace(/^.*?:/, "") // strip prefix like "Scores:"
    .replace(/[^0-9,.-]/g, "");

  if (!SCORE_PATTERN.test(cleaned)) return null;

  const tokens = cleaned.split(",").filter(Boolean);
  if (tokens.length < expected) return null;

  const scores: number[] = [];
  for (const t of tokens.slice(0, expected)) {
    const n = parseFloat(t);
    if (isNaN(n)) return null;
    scores.push(n);
  }
  return scores;
}
