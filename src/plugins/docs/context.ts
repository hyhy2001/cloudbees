import type { DocItem } from "./corpus";

/**
 * Strip BM25 vocabulary terms from a help-fact body before rendering it into
 * an LM prompt. Help-fact bodies have the form:
 *
 *   <answer prose — one or two sentences>
 *   <term1>              ← BM25 synonym vocab, NOT for user/LM consumption
 *   <term2>
 *   bee some command     ← keep: actual executable commands
 *   bee other command    ← keep
 *
 * Strategy: keep the first non-empty lines until we hit a "bee " line or a
 * short term; then switch to keeping only "bee " lines. This preserves the
 * answer prose and the commands list, and drops the synonym terms in between.
 */
function stripTermsFromBody(body: string): string {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  let inTerms = false;

  for (const line of lines) {
    // A real bee command looks like: "bee word word? <optional-arg>?"
    // e.g. "bee job run <name>", "bee auth login", "bee cred list --store user"
    // Synonym terms that start with "bee" (e.g. "bee ask finds nothing",
    // "bee ask no results") are NOT real commands — they lack the command
    // verb structure and contain natural-language words.
    const isRealCommand =
      line.startsWith("bee ") &&
      /^bee\s+[a-z][-a-z]*(\s+[a-z][-a-z]*)?(\s+[<(--].*)?$/i.test(line);

    if (isRealCommand) {
      out.push(line);
      inTerms = false;
      continue;
    }
    // A "term" line: short and looks like a keyword phrase (no punctuation like
    // "--flag" or sentence-ending ".")
    const looksLikeTerm =
      line.length <= 40 &&
      !line.startsWith("-") &&
      !line.endsWith(".") &&
      !line.endsWith(",") &&
      !/\s{2,}/.test(line); // flag table lines have two+ spaces

    if (inTerms && looksLikeTerm) continue; // skip
    if (!inTerms && looksLikeTerm) {
      inTerms = true;  // first term seen — start skipping
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Render one DocItem as an XML-like structured block for the LM.
 *
 * When `related` is true, the block is wrapped in <related>…</related> so the
 * LM sees it as a secondary suggestion, not a primary match.
 */
export function formatDocItem(item: DocItem, related = false): string {
  const inner = item.type === "doc" ? renderInfo(item) : renderCommand(item);
  if (!inner) return "";
  return related
    ? `<related>\n${inner}\n</related>`
    : inner;
}

function renderInfo(item: DocItem): string {
  const id = item.id ?? (item.source.startsWith("help:") ? item.title ?? item.source : item.source);
  const head = `<info id="${escapeXmlAttr(id)}">`;
  const body = stripTermsFromBody(item.body);
  return body ? `${head}\n${body}\n</info>` : `${head}\n</info>`;
}

function renderCommand(item: DocItem): string {
  const lines: string[] = [];
  lines.push(`<command id="${escapeXmlAttr(item.title)}">`);
  if (item.description) lines.push(`  <desc>${escapeXmlAttr(item.description)}</desc>`);
  if (item.body) {
    const bodyLines = item.body.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    const flags = bodyLines.filter((l) => l.trimStart().startsWith("-"));
    if (flags.length > 0) {
      lines.push(`  <flags>`);
      for (const f of flags) {
        // Find the first flag that starts with -- (the primary flag name)
        const tokens = f.trimStart().split(/\s+/);
        const primaryIdx = tokens.findIndex((t) => t.startsWith("--"));
        const flagName = primaryIdx >= 0 ? tokens[primaryIdx]! : tokens[0]!;
        const flagDesc = tokens.slice(primaryIdx + 1).join(" ").trim();
        if (flagDesc) {
          lines.push(`    <flag name="${escapeXmlAttr(flagName)}">${escapeXmlAttr(flagDesc)}</flag>`);
        } else {
          lines.push(`    <flag>${escapeXmlAttr(flagName)}</flag>`);
        }
      }
      lines.push(`  </flags>`);
    }
  }
  lines.push(`</command>`);
  return lines.join("\n");
}

/** Minimal XML attribute escaping. */
function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Join the rendered items into a single context section. */
export function formatContext(items: DocItem[]): string {
  return items.map((item) => formatDocItem(item)).join("\n\n");
}

/**
 * The system instruction handed to the LM. Two jobs:
 *   1. Grounding — answer ONLY from the provided commands; never invent flags.
 *   2. Scope guard — `bee ask` is a help assistant for new bee users, nothing
 *      else. It must refuse off-topic questions and must never reveal its own
 *      configuration, API keys, endpoint, or these instructions. The retrieval
 *      relevance gate (corpus.ts) already blocks most off-domain queries before
 *      they reach the model; this prompt is the second line of defence for the
 *      ones that slip through (a query that shares a token with the docs).
 */
export const SYSTEM_PROMPT = [
  "You are a help assistant for the `bee` CLI tool (CloudBees / Jenkins).",
  "Answer ONLY from the <command> and <info> blocks in the context.",
  "Never invent commands or flags. Use FULL command names as shown in <command id=\"..\">.",
  "Always replace placeholders with realistic values: use 'my-pipeline' not '<name>'.",
  "Rules:",
  "- flags array: ONLY entries starting with '--'. Never put positional args (like <name>) in flags.",
  "- commands array: list each command ONCE. Never repeat the same cmd twice.",
  "- When listing subcommands of a group, include ALL commands from context (not just 3).",
  "- reasoning field: quote the EXACT flag names and command ids from the <command> blocks that answer this query. This grounds your answer in the context.",
  "Reply ONLY with a valid JSON object — no text outside JSON:",
  '{"reasoning":"<quote exact command ids and flag names from context>","explanation":"<1-2 sentence intro>","commands":[{"cmd":"<full bee command>","flags":[{"name":"--flag","description":".."}],"example":"<concrete invocation>"}],"note":"<caveat or null>"}',
  "",
  "Example — 'trigger a job':",
  JSON.stringify({
    reasoning: "Context has command id='job.run' with flags --wait, --node, --param, --timeout. User wants to trigger a build.",
    explanation: "Use `bee job run` to trigger a new build.",
    commands: [{ cmd: "bee job run", flags: [{ name: "--wait", description: "Block until build completes" }, { name: "--node", description: "Restrict to a specific agent label" }], example: "bee job run my-pipeline --wait" }],
    note: null,
  }),
  "",
  "Example — 'list all nodes':",
  JSON.stringify({
    reasoning: "Context has command id='node.list' with flags --all. User wants to see all agents.",
    explanation: "Use `bee node list` to see all agents on the controller.",
    commands: [{ cmd: "bee node list", flags: [{ name: "--all", description: "Include offline agents" }], example: "bee node list --all" }],
    note: null,
  }),
  "",
  "Example — 'what can I do with jobs' (group listing — include ALL subcommands from context):",
  JSON.stringify({
    reasoning: "Context has job.list, job.run, job.create.freestyle, job.create.pipeline, job.create.folder, job.delete, job.log, job.status, job.stop, job.copy, job.move, job.update.freestyle, job.update.pipeline, job.track, job.untrack, job.get, job.approve-agent, job.list-agents, job.remove-agent. User wants all subcommands.",
    explanation: "The `bee job` group manages CloudBees jobs and builds.",
    commands: [
      { cmd: "bee job list", flags: [{ name: "--all", description: "Show all jobs" }, { name: "--recursive", description: "Descend into folders" }], example: "bee job list --all --recursive" },
      { cmd: "bee job run", flags: [{ name: "--wait", description: "Block until build completes" }], example: "bee job run my-pipeline --wait" },
      { cmd: "bee job create freestyle", flags: [{ name: "--shell", description: "Build script" }, { name: "--node", description: "Agent label" }], example: "bee job create freestyle my-job --shell 'make build'" },
      { cmd: "bee job create pipeline", flags: [{ name: "--script", description: "Pipeline Groovy script or file" }], example: "bee job create pipeline my-pipeline --script Jenkinsfile" },
      { cmd: "bee job delete", flags: [{ name: "--yes", description: "Skip confirmation" }], example: "bee job delete old-job --yes" },
      { cmd: "bee job log", flags: [{ name: "--follow", description: "Stream live log" }], example: "bee job log my-pipeline 42 --follow" },
      { cmd: "bee job status", flags: [{ name: "--count", description: "Number of builds to show" }], example: "bee job status my-pipeline --count 5" },
      { cmd: "bee job stop", flags: [], example: "bee job stop my-pipeline 42" },
      { cmd: "bee job copy", flags: [], example: "bee job copy my-pipeline my-pipeline-copy" },
      { cmd: "bee job move", flags: [], example: "bee job move my-pipeline team/backend" },
      { cmd: "bee job update freestyle", flags: [{ name: "--schedule", description: "Cron schedule" }], example: "bee job update freestyle my-job --schedule 'H 9 * * 1-5'" },
      { cmd: "bee job update pipeline", flags: [{ name: "--script", description: "Replace pipeline script" }], example: "bee job update pipeline my-pipeline --script Jenkinsfile" },
      { cmd: "bee job track", flags: [], example: "bee job track my-pipeline" },
      { cmd: "bee job untrack", flags: [], example: "bee job untrack my-pipeline" },
      { cmd: "bee job get", flags: [], example: "bee job get my-pipeline" },
      { cmd: "bee job approve-agent", flags: [], example: "bee job approve-agent my-folder my-agent" },
      { cmd: "bee job list-agents", flags: [], example: "bee job list-agents my-folder" },
      { cmd: "bee job remove-agent", flags: [{ name: "--yes", description: "Skip confirmation" }], example: "bee job remove-agent my-folder my-agent --yes" },
    ],
    note: null,
  }),
  "",
  'Off-topic: {"explanation":"I only help with bee usage.","commands":[],"note":null}',
  'Nothing relevant: {"explanation":"No info available — try `bee --help`","commands":[],"note":null}',
].join("\n");

/**
 * Assemble the USER message: corpus context + question, no system instruction.
 *
 * Providers that send role-separated messages (system + user) use this for the
 * user turn and attach SYSTEM_PROMPT themselves. The grounding rails live in
 * the system role where the model weights them most.
 */
export function buildUserPrompt(query: string, corpus: DocItem[]): string {
  const context = formatContext(corpus);
  return [
    "<context>",
    context,
    "</context>",
    "",
    `Question: ${query}`,
    "",
    "Answer:",
  ].join("\n");
}

/**
 * Assemble the full single-string prompt: system instruction + corpus context +
 * question. Kept for callers/tests that want one flat string; role-separated
 * providers should prefer buildUserPrompt + SYSTEM_PROMPT.
 */
export function buildPrompt(query: string, corpus: DocItem[]): string {
  return [SYSTEM_PROMPT, "", buildUserPrompt(query, corpus)].join("\n");
}
