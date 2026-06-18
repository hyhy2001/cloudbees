/**
 * Command-tree corpus + hybrid doc search for `bee ask`.
 *
 * Retrieval is backed by SQLite FTS5 (BM25 ranking). The corpus is built from
 * two sources that are merged into one FTS5 index:
 *
 *   1. Live commander tree  — "command" items, always up-to-date (rebuilt each call).
 *   2. Embedded docs/*.md   — "doc" items, chunked by heading, inlined into the
 *                             binary at build time via docs-index.ts.
 *
 * Merging both into a single FTS5 table means a single ranked query covers
 * "what command do I use" AND "what does Mine mean" AND "how do I fix a 403"
 * simultaneously. BM25 column weights keep command-name hits ranked above
 * documentation prose hits for short command queries, but long natural-language
 * questions will naturally surface the relevant doc section.
 *
 * Adding Databricks (or any LM): this file only does retrieval; the answer
 * layer (answer.ts) handles generation. Nothing here changes when you add a
 * provider.
 */
import { Database } from "bun:sqlite";
import type { Command } from "commander";
import { buildDocChunks } from "./docs-index";
import { HELP_FACTS } from "../../generated/help-index";

// ─── DocItem ─────────────────────────────────────────────────────────────────

export interface DocItem {
  /** Stable id: "job.run" for commands, "concepts.md#mine-vs-all" for doc chunks. */
  id: string;
  /**
   * "command" — a live CLI command from the commander tree.
   * "doc"     — a section from an embedded markdown file.
   */
  type: "command" | "doc";
  /** For commands: "bee job run <name>". For doc chunks: heading text. */
  title: string;
  /** One-line description (command description or source file label). */
  description: string;
  /**
   * Main body text indexed by FTS5.
   * Commands: flag table.  Doc chunks: section prose.
   */
  body: string;
  /** Source label shown when rendering (e.g. "cli/job.md", "command"). */
  source: string;
}

// ─── BM25 column weights ──────────────────────────────────────────────────────
//
// Column order in the FTS5 CREATE TABLE must match these positional weights.
// UNINDEXED columns (id, type, source) are skipped by bm25().
// Command title hits (exact "bee job run") outweigh doc headings, which
// outweigh body prose. This keeps "bee ask login" pointing at auth commands
// while "bee ask what is a profile" surfaces the concepts doc section.

const W = { title: 10.0, description: 5.0, body: 1.0 } as const;

// ─── Commander tree walker ────────────────────────────────────────────────────

function argsSig(cmd: Command): string {
  return cmd.registeredArguments
    .map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`))
    .join(" ");
}

function walkCommands(cmd: Command, path: string[], out: DocItem[]): void {
  for (const sub of cmd.commands) {
    const subPath = [...path, sub.name()];
    const desc = sub.description();
    const flagBody = sub.options
      .map((o) => `${o.flags.padEnd(28)}${o.description}`)
      .join("\n");

    if (desc || sub.options.length > 0) {
      const sig = argsSig(sub);
      const usage = ["bee", ...subPath, sig].filter(Boolean).join(" ");
      out.push({
        id: subPath.join("."),
        type: "command",
        title: usage,
        description: desc,
        body: flagBody,
        source: "command",
      });
    }

    walkCommands(sub, subPath, out);
  }
}

// ─── Corpus builder ───────────────────────────────────────────────────────────

export interface BuildCorpusOptions {
  includeDocChunks?: boolean;
}

export function buildCorpus(program: Command, opts: BuildCorpusOptions = {}): DocItem[] {
  const items: DocItem[] = [];

  // 1. Command tree
  walkCommands(program, [], items);

  // 2. Generated help facts
  for (const fact of HELP_FACTS) {
    items.push({
      id: fact.id,
      type: "doc",
      title: fact.title,
      description: fact.kind,
      // Include terms in body so BM25 can match user vocabulary (e.g. "mine",
      // "switch controller", "kill build") against fact entries.
      body: [fact.answer, ...fact.terms, ...fact.commands, ...fact.related].join("\n"),
      source: `help:${fact.kind}`,
    });
  }

  // 3. Embedded doc chunks (dev / fallback only)
  if (opts.includeDocChunks ?? process.env["BEE_ASK_INCLUDE_DOC_CHUNKS"] === "1") {
    for (const chunk of buildDocChunks()) {
      items.push({
        id: chunk.id,
        type: "doc",
        title: chunk.heading,
        description: chunk.source,
        body: chunk.body,
        source: chunk.source,
      });
    }
  }

  return items;
}

// ─── Match expression builder ─────────────────────────────────────────────────

/**
 * English stopwords — high-frequency tokens that carry no retrieval signal.
 * Removing them keeps FTS5 MATCH tight: "how do I run a build" → "run build",
 * which ranks better than OR-joining "how","do","i","a" (all of which appear
 * everywhere in the docs and dilute the BM25 score).
 */
const STOP_WORDS = new Set([
  "a","an","the","is","it","its","be","are","was","were","been","being",
  "have","has","had","do","does","did","doing","will","would","could",
  "should","may","might","shall","can","need","dare","ought","used",
  "i","me","my","we","our","you","your","he","she","they","them","their",
  "this","that","these","those","which","whom","whose",
  // NOTE: "what" and "who" are kept out of stopwords so synonyms fire:
  // what→concept, who→profiles
  "how","why","when","where","if","then","else","so","as","at","by",
  "for","from","in","into","of","on","or","and","but","not","no","nor",
  "to","up","out","with","about","after","before","between","through",
  "during","without","within","against","along","across","behind","beyond",
  "down","off","over","under","above","below","per","via",
]);

/**
 * Domain synonym map: normalise user vocabulary → canonical doc terms.
 *
 * Each key is a token a user might type; its value is the token that actually
 * appears in the command tree or docs. Expansion is one-to-one; a key maps
 * to exactly one canonical term, which is then prefix-matched ("canonical"*).
 *
 * Add entries here when `bee ask` misses an obvious user phrasing.
 */
const SYNONYMS: Record<string, string> = {
  // job / build actions
  kill:        "stop",
  cancel:      "stop",
  abort:       "stop",
  terminate:   "stop",
  halt:        "stop",
  interrupt:   "stop",
  kick:        "run",    // "kick off a build" → job run
  remove:      "delete",
  rm:          "delete",
  revoke:      "delete",   // "revoke a token" → credential delete
  rotate:      "update",   // "rotate a secret" → credential update
  invalidate:  "delete",   // "invalidate a credential"
  details:     "get",      // "show credential details" → get
  erase:       "delete",
  destroy:     "delete",
  expire:      "delete",   // "expire a credential" → cred delete
  rid:         "delete",   // "get rid of" → delete
  make:        "create",
  add:         "create",
  new:         "create",
  save:        "create",   // "save api key", "save credential"
  provision:   "create",
  register:    "create",
  setup:       "create",
  build:       "job",
  pipeline:    "job",
  project:     "job",
  folder:      "job",      // "create folder" → job create folder
  trigger:     "run",
  launch:      "run",
  execute:     "run",
  start:       "run",
  clone:       "copy",
  duplicate:   "copy",
  rename:      "move",
  relocate:    "move",
  configure:   "update",
  edit:        "update",
  existing:    "update",   // "add X to existing job" → job update
  modify:      "update",
  change:      "update",
  // build output / history
  // NOTE: "follow" not mapped here — too ambiguous ("follow a credential" = cred.track)
  // job.log description contains "follow" explicitly for --follow flag
  watch:       "log",
  tail:        "log",
  stream:      "log",
  output:      "log",
  history:     "status",
  recent:      "status",
  runs:        "status",
  results:     "status",  // "recent build results" → job status
  // tracking
  track:       "track",
  tracking:    "track",   // "start/stop tracking" → track/untrack
  pin:         "track",   // "pin a credential" → cred track
  // concepts / questions
  what:        "concept",  // "what is X" → surface concept facts
  explain:     "concept",
  define:      "concept",
  meaning:     "concept",
  // NOTE: "how" not mapped — too broad ("how do I log in" should go to auth.login, not concept)
  mine:        "mine",     // kept as-is so "mine" matches concept.mine-vs-all title
  // auth-specific synonyms
  authenticate: "login",
  connect:      "login",   // "connect to server" → login
  disconnect:   "logout",
  logged:       "login",   // "am I logged in" → auth.login / profiles
  expired:      "login",   // "token expired" → login troubleshooting
  // nodes / agents
  agent:        "node",
  slave:        "node",
  worker:       "node",
  executor:     "node",
  machine:      "node",
  server:       "node",
  decommission: "delete",  // "decommission a node" → node delete
  inspect:      "get",     // "inspect node details" → node get
  label:        "labels",  // "add label to node" → node update --labels
  maintenance:  "offline", // "put node in maintenance mode" → node offline
  disable:      "offline",
  suspend:      "offline",
  pause:        "offline",
  shutdown:     "offline",
  deactivate:   "offline",
  enable:       "online",
  resume:       "online",
  restore:      "online",
  activate:     "online",
  // credentials / secrets
  secret:      "credential",
  token:       "credential",
  password:    "credential",
  key:         "credential",
  apikey:      "credential",
  // NOTE: "ssh" not mapped — "create ssh node" would incorrectly surface cred.create
  api:         "credential",
  cert:        "credential",
  certificate: "credential",
  // troubleshooting
  denied:       "403",     // "access denied" → troubleshooting.403
  forbidden:    "403",
  disconnecting: "connect", // "agent disconnecting" → node-connect troubleshooting
  connecting:   "connect",
  unreachable:  "connect",
  // auth / profiles
  signin:      "login",
  "sign-in":   "login",
  logon:       "login",  // "logon to server" → auth.login
  // NOTE: "sign" alone not mapped — "sign out" would collapse to just "sign"→"login"
  // which incorrectly surfaces auth.login. auth.logout description contains "sign out".
  signout:     "logout",
  "sign-out":  "logout",
  signoff:     "logout",
  logout:      "logout",
  account:     "profile",
  user:        "profile",  // "switch user" → profile context
  switch:      "use",       // bee auth switch = bee auth use
  whoami:      "profiles",
  // NOTE: "who" not mapped to profiles — "which controller am I on" would fire auth.profiles instead of controller.current
  // controller
  master:      "controller",
  instance:    "controller",
  use:         "select",    // "use controller" → controller select
  // navigation
  list:        "list",
  show:        "list",
  view:        "list",
  display:     "list",
  see:         "list",
  get:         "get",
  fetch:       "get",
  find:        "get",
  look:        "get",
  // environment / config
  env:         "environment",
  var:         "variable",
  vars:        "variable",
  envvar:      "environment",
  // misc
  tui:           "ui",
  interactive:   "ui",
  help:          "ask",
  search:        "ask",
  whitelist:     "approve",    // "whitelist agent for folder" → job approve-agent
  grant:         "approve",    // "grant agent access" → job approve-agent
  docs:          "ask",
  notification:  "email",      // "add email notification" → job create/update email option
  notify:        "email",      // "notify on failure" → email flags
  count:         "status",     // "show last N builds" → job status --count
  parameter:     "param",      // "pass parameter" → job run --param / --param-def
  params:        "param",      // "with params" → job run/create/update
  directory:     "dir",        // "working directory" → --chdir / --remote-dir
  slot:          "executor",   // "build slots" → --executors
  slots:         "executor",
  scope:         "credential", // "credential scope" → cred create --scope
  assign:        "node",       // "assign job to node" → --node flag
};

/**
 * Expand one token through the synonym map and return the canonical term.
 * Input and output are both lowercase single tokens (no spaces).
 */
export function expandToken(token: string): string {
  return SYNONYMS[token] ?? token;
}

/**
 * Turn a free-text query into a safe FTS5 MATCH expression.
 *
 * Pipeline:
 *   1. Lowercase + split on non-alphanumeric
 *   2. Drop stopwords (English fillers with no retrieval signal)
 *   3. For each remaining token, emit BOTH the original AND its synonym (if any)
 *   4. Deduplicate
 *   5. Each token → prefix term ("token"*), OR-joined
 *
 * Returns "" when nothing survives filtering (caller skips the search).
 *
 * Synonyms ADD to the query rather than replace: "remove agent" expands to
 * remove OR delete OR agent OR node. Replacing instead would drop the exact
 * token, so a command literally named "remove-agent" would lose its own
 * name match to the synonym target. OR-join maximises recall — the LM (or
 * BM25 ranking) picks the relevant result from top-K.
 */
export function buildMatchExpr(query: string): string {
  const raw = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);

  const expanded: string[] = [];
  for (const t of raw) {
    if (STOP_WORDS.has(t)) continue;
    expanded.push(t);
    const syn = expandToken(t);
    if (syn !== t) expanded.push(syn);
  }

  // Deduplicate while preserving first-seen order
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const t of expanded) {
    if (!seen.has(t)) { seen.add(t); tokens.push(t); }
  }

  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

// ─── Relevance gate ────────────────────────────────────────────────────────
//
// FTS5/BM25 returns hits whenever ANY query token prefix-matches a document,
// so an off-domain question that happens to share one common word ("delete my
// email account" → the `delete` token hits `auth.delete`) still retrieves
// results. The raw BM25 score does NOT separate these from real matches — a
// garbage query can score "stronger" (more negative) than a valid one because
// score scales with token rarity, not with how much of the QUESTION was
// covered. The signal that does separate them is COVERAGE: a real query has
// most of its content tokens present in the hit; a coincidental one matches a
// single token and misses the rest.
//
// The gate is therefore: coverage >= GATE_COV_MIN AND >= 2 distinct content
// tokens matched — unless the query has only one content token, where a single
// match is all there is. Thresholds were calibrated by probing on-domain vs
// off-domain queries (see scripts/rag-eval.ts off-domain suite): on-domain
// queries pass, ~7/8 token-coincidence queries are rejected.
//
// Opt-in via searchDocs(..., { gate: true }). Default OFF so the raw `bee ask`
// fallback keeps its existing behaviour; the gate is for the LM path, where
// feeding coincidental context produces confident hallucinations.

const GATE_COV_MIN = 0.6;

/** Content tokens of a query: 3+ chars, non-stopword, lowercased. */
function contentTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

/**
 * How much of the query's content vocabulary is present in this item.
 * A token counts as present if it (or its synonym expansion) appears anywhere
 * in the item's searchable text. Returns matched/total and the ratio.
 */
export function relevanceCoverage(
  query: string,
  item: DocItem,
): { cov: number; matched: number; total: number } {
  const blob = `${item.title} ${item.description} ${item.body}`.toLowerCase();
  const toks = contentTokens(query);
  if (toks.length === 0) return { cov: 0, matched: 0, total: 0 };
  let matched = 0;
  for (const t of toks) {
    if (blob.includes(t) || blob.includes(expandToken(t))) matched++;
  }
  return { cov: matched / toks.length, matched, total: toks.length };
}

/**
 * Does this hit clear the relevance bar for the query? See the gate rationale
 * above. A query with no content tokens (all stopwords/symbols) never passes.
 */
export function passesRelevanceGate(query: string, item: DocItem): boolean {
  const { cov, matched, total } = relevanceCoverage(query, item);
  if (total === 0) return false;
  if (cov < GATE_COV_MIN) return false;
  if (total === 1) return matched >= 1;
  return matched >= 2;
}

// ─── FTS5 search ──────────────────────────────────────────────────────────────

interface SearchRow {
  id: string;
  type: "command" | "doc";
  title: string;
  description: string;
  body: string;
  source: string;
}

export interface SearchOptions {
  /**
   * When true, drop hits that fail the relevance gate (off-domain / token-
   * coincidence). Default false — the raw fallback keeps every BM25 hit.
   */
  gate?: boolean;
  /**
   * Only meaningful with `gate: true`. When the gate empties every hit but BM25
   * did return matches, fall back to the ungated hits instead of returning
   * nothing.
   *
   * Use on the raw `bee ask` path: with no LM, an empty result is worse than a
   * slightly-off hit — natural-language doc queries ("how does the cache work")
   * phrase content in words absent from the doc body and the gate would
   * otherwise wrongly empty them.
   *
   * Leave OFF on the LM path: there, an empty gate is the desired signal (the
   * model says "no matching command") and resurrecting coincidental context
   * produces confident hallucinations — the exact case the gate exists to stop.
   */
  softGate?: boolean;
}

export function searchDocs(
  query: string,
  corpus: DocItem[],
  limit = 5,
  opts: SearchOptions = {},
): DocItem[] {
  const match = buildMatchExpr(query);
  if (match === "" || corpus.length === 0) return [];

  const db = new Database(":memory:");
  try {
    // UNINDEXED columns (id, type, source) are not tokenised and skipped by
    // bm25() — weights are positional over the indexed columns: title,
    // description, body.
    db.run(`CREATE VIRTUAL TABLE docs USING fts5(
      id          UNINDEXED,
      type        UNINDEXED,
      title,
      description,
      body,
      source      UNINDEXED
    )`);

    const insert = db.prepare(
      "INSERT INTO docs (id, type, title, description, body, source) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertAll = db.transaction((items: DocItem[]) => {
      for (const d of items) {
        insert.run(d.id, d.type, d.title, d.description, d.body, d.source);
      }
    });
    insertAll(corpus);

    // When gating, over-fetch then filter: the gate may drop several top hits,
    // so a raw LIMIT would starve the result. Cap the over-fetch to avoid
    // scanning the whole table on a broad query.
    const fetchLimit = opts.gate ? Math.min(limit * 5, corpus.length) : limit;

    const rows = db
      .query<SearchRow, [string, number, number, number, number]>(
        `SELECT id, type, title, description, body, source
           FROM docs
          WHERE docs MATCH ?
          ORDER BY bm25(docs, 0.0, 0.0, ?, ?, ?, 0.0)
          LIMIT ?`,
      )
      .all(match, W.title, W.description, W.body, fetchLimit);

    const items: DocItem[] = rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      description: r.description,
      body: r.body,
      source: r.source,
    }));

    const gated = opts.gate
      ? items.filter((item) => passesRelevanceGate(query, item))
      : items;

    // Soft gate (opt-in via softGate): if the gate empties every hit but BM25
    // did return matches, fall back to the ungated hits. Raw `bee ask` path
    // wants this — an empty result is worse than a slightly-off hit. The LM
    // path leaves it OFF so an empty gate stays empty (no hallucination fuel).
    const final = opts.gate && opts.softGate && gated.length === 0 ? items : gated;

    return final.slice(0, limit);
  } finally {
    db.close();
  }
}
