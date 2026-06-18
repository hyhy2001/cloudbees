import type { DocItem } from "./corpus";

export interface PresentedAnswer {
  text: string;
}

function isQuestionLike(query: string): boolean {
  return /\b(what|why|how|error|403|401|fail|failed|troubleshoot|problem|issue|is|are|does|can)\b/i.test(query);
}

function extractFlags(body: string, max = 5): string[] {
  return body
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trimStart().startsWith("-"))
    .slice(0, max);
}

/** Pull command list from a help-fact body (lines starting with "bee "). */
function extractCommands(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("bee "));
}

function relatedCommands(hits: DocItem[], excludeId: string, max = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits) {
    if (hit.type !== "command" || hit.id === excludeId) continue;
    if (seen.has(hit.title)) continue;
    seen.add(hit.title);
    out.push(hit.title);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Format a command answer. Shows usage, key flags, and a concrete example
 * so new users know exactly what to type and where to find arguments.
 */
function presentCommand(hit: DocItem, hits: DocItem[]): string {
  const lines: string[] = [];

  lines.push(`  ${hit.title}`);
  if (hit.description) lines.push(`  ${hit.description}`);

  const flags = extractFlags(hit.body);
  if (flags.length > 0) {
    lines.push("");
    lines.push("Options:");
    for (const f of flags) lines.push(`  ${f.trimStart()}`);
  }

  const related = relatedCommands(hits, hit.id);
  if (related.length > 0) {
    lines.push("");
    lines.push("See also:");
    for (const cmd of related) lines.push(`  ${cmd}`);
  }

  return lines.join("\n");
}

/**
 * Format a concept or troubleshooting answer. Shows the full answer text
 * (facts are already short) followed by the commands to use.
 */
function presentDoc(hit: DocItem, hits: DocItem[], query: string): string {
  const lines: string[] = [];

  // Extract the prose answer — first line(s) that are not commands or terms
  // (terms are vocabulary keywords baked into body for BM25, not user-facing).
  const bodyLines = hit.body.split("\n").map((l) => l.trim()).filter(Boolean);
  const answerLines = bodyLines.filter((l) => !l.startsWith("bee ") && l.length > 20);
  const cmdLines = extractCommands(hit.body);

  const answer = answerLines.join(" ");
  if (answer) lines.push(answer);

  if (cmdLines.length > 0) {
    lines.push("");
    lines.push("Commands:");
    for (const cmd of cmdLines) lines.push(`  ${cmd}`);
  } else {
    // No embedded commands — pull relevant command hits instead.
    const commandHits = hits
      .filter((h) => h.type === "command" && !isQuestionLike(query))
      .slice(0, 3)
      .map((h) => h.title);
    if (commandHits.length > 0) {
      lines.push("");
      lines.push("Commands:");
      for (const cmd of commandHits) lines.push(`  ${cmd}`);
    }
  }

  return lines.join("\n");
}

function rankForPresentation(query: string, hits: DocItem[]): DocItem[] {
  const questionLike = isQuestionLike(query);
  const score = (hit: DocItem): number => {
    if (questionLike) {
      if (hit.source.startsWith("help:")) return 300;
      if (hit.type === "doc") return 200;
      return 100;
    }
    if (hit.type === "command") return 300;
    if (hit.source.startsWith("help:")) return 200;
    return 100;
  };
  return [...hits].sort((a, b) => score(b) - score(a));
}

export function presentAnswer(query: string, hits: DocItem[]): PresentedAnswer {
  if (hits.length === 0) {
    return {
      text: `No results for '${query}'.\nTry: bee --help  or  bee ask <shorter keyword>`,
    };
  }

  const ranked = rankForPresentation(query, hits);
  const top = ranked[0]!;
  const text =
    top.type === "command"
      ? presentCommand(top, ranked)
      : presentDoc(top, ranked, query);

  return { text };
}
