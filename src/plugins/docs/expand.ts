/**
 * Expand a user query by asking the LM to translate it into canonical
 * bee command terms before BM25 retrieval.
 *
 * This bridges the gap between diverse natural-language phrasings and
 * BM25's token-based matching. The LM generates relevant bee command
 * names/keywords, which are appended to the original query for BM25.
 */

const EXPAND_PROMPT = [
  "You are a query expander for the `bee` CLI tool.",
  "Given a user request, list the most relevant bee command(s) or keywords.",
  "Only return bee command words (e.g. job, node, cred, run, stop, list, create, delete, update, login, profile).",
  "Return nothing if no bee command is relevant.",
  "",
  "User: \"${QUERY}\"",
  "Relevant bee terms:",
].join("\n");

export async function expandQuery(
  query: string,
  generate: (prompt: string) => Promise<string>,
): Promise<string> {
  if (query.length < 3) return query;

  const prompt = EXPAND_PROMPT.replace("${QUERY}", query.replace(/"/g, "'"));

  let expansion: string;
  try {
    expansion = await generate(prompt);
  } catch {
    return query; // fall back to original
  }

  // Clean: remove punctuation, lowercase, keep only short tokens.
  const terms = expansion
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && t.length < 20 && !["bee", "the", "for", "and", "with"].includes(t))
    .join(" ");

  if (!terms) return query;

  // Append expansion tokens to original query so BM25 matches either.
  return `${query} ${terms}`;
}
