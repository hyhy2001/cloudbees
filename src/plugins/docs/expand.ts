/**
 * Expand a user query by classifying it into canonical bee command terms
 * using cosine similarity between query embedding and pre-computed label
 * embeddings (MiniLM, already bundled in binary).
 *
 * No API call — uses the same @xenova/transformers + MiniLM model
 * that powers vector search and reranker.
 *
 * If MiniLM is unavailable, returns original query as-is.
 */

import { embed, cosineSimilarity } from "./vector";

const LABELS: { label: string; terms: string[] }[] = [
  { label: "create job",      terms: ["create", "job", "new", "make", "freestyle", "pipeline"] },
  { label: "run job",         terms: ["run", "job", "trigger", "build", "start", "execute", "launch"] },
  { label: "stop job",        terms: ["stop", "job", "cancel", "abort", "kill", "build"] },
  { label: "delete job",      terms: ["delete", "job", "remove", "nuke", "erase"] },
  { label: "list jobs",       terms: ["list", "job", "all", "show", "everything"] },
  { label: "update job",      terms: ["update", "job", "edit", "modify", "change", "configure"] },
  { label: "job log",         terms: ["log", "job", "console", "output", "follow", "stream"] },
  { label: "create node",     terms: ["create", "node", "agent", "new"] },
  { label: "delete node",     terms: ["delete", "node", "agent", "remove"] },
  { label: "node online",     terms: ["online", "node", "bring", "up", "enable"] },
  { label: "node offline",    terms: ["offline", "node", "down", "disable", "maintenance"] },
  { label: "create cred",     terms: ["create", "credential", "cred", "secret", "token"] },
  { label: "delete cred",     terms: ["delete", "credential", "cred", "remove"] },
  { label: "auth login",      terms: ["login", "auth", "profile", "authenticate"] },
  { label: "auth use",        terms: ["switch", "profile", "use", "auth", "change"] },
  { label: "controller select", terms: ["controller", "select", "choose", "active"] },
  { label: "track resource",  terms: ["track", "untrack", "mine", "follow"] },
];

let _labelEmbeds: { label: string; terms: string[]; vec: number[] }[] | null = null;

async function getLabelEmbeds(): Promise<typeof _labelEmbeds> {
  if (_labelEmbeds) return _labelEmbeds;
  const embs = await Promise.all(LABELS.map(async (l) => ({
    label: l.label,
    terms: l.terms,
    vec: (await embed(l.label)) ?? new Array(384).fill(0),
  })));
  _labelEmbeds = embs;
  return embs;
}

export async function expandQuery(query: string): Promise<string> {
  if (query.length < 3) return query;

  const queryEmb = await embed(query);
  if (!queryEmb) return query; // MiniLM unavailable

  try {
    const labels = await getLabelEmbeds();
    const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

    // Score each label by cosine similarity with query.
    const scored = labels
      .map((l) => ({ label: l, score: cosineSimilarity(queryEmb, l.vec) }))
      .sort((a, b) => b.score - a.score);

    // Collect expansion terms from top-1 label (if meaningfully similar).
    const terms = new Set<string>();
    if (scored.length > 0 && scored[0]!.score > 0.15) {
      for (const t of scored[0]!.label.terms) {
        if (!tokens.includes(t)) terms.add(t);
      }
      // Also try top-2 if scores are close (within 10%).
      if (scored.length > 1 && scored[1]!.score > 0.15 && scored[1]!.score > scored[0]!.score * 0.85) {
        for (const t of scored[1]!.label.terms) {
          if (!tokens.includes(t)) terms.add(t);
        }
      }
    }

    if (terms.size === 0) return query;
    return `${query} ${[...terms].join(" ")}`;
  } catch {
    return query;
  }
}
