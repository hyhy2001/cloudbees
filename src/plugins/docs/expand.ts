/**
 * Query expansion — placeholder.
 *
 * MiniLM-based expansion was evaluated but found to be too conservative:
 * the 3B embedding model couldn't reliably disambiguate labels for short
 * CLI queries, and the synonym map in corpus.ts already covers the common
 * user vocabulary (kick→run, kill→stop, nuke→delete, etc.).
 *
 * BM25 + synonym expansion + MiniLM reranker + graph expansion together
 * achieve 94%+ correct command rate with 0 API calls for retrieval.
 *
 * Expansion is kept as a no-op seam — re-enable by adding a function that
 * returns the original query with additional terms appended.
 */

export async function expandQuery(query: string): Promise<string> {
  return query;
}
