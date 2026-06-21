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
  /** Stable id: "job.run" for commands, "concepts/profiles.md#switch-active-profile" for doc chunks. */
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
  "a","an","the","is","am","it","its","be","are","was","were","been","being",
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
  // Conversational filler that inflates the relevance-gate denominator without
  // adding retrieval signal ("agent wont COME online", "am i on this").
  "come","comes","coming",
  // "jenkins" carries no discriminating signal in a corpus where every doc is
  // about Jenkins, and inflated the gate denominator ("JENKINS agent wont come
  // online"). NB: "cloudbees" is deliberately NOT a stopword — dropping it
  // reranked "sign in to cloudbees" so auth.logout outscored auth.login.
  "jenkins",
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
  monitor:     "track",  // "monitor a job" → job.track
  watch:       "track",  // "watch job" → job.track, not job.log
  // NOTE: "watch" was previously mapped to "log" which caused "watch job"
  // to surface job.log instead of job.track. Changed to "track".
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
  // NOTE: "server" deliberately NOT mapped. A beginner saying "my server",
  // "connect to my server", or "add my jenkins server" means the CloudBees
  // SERVER (login / controller), not a build agent. Mapping server→node sent
  // those queries to node/cred. Left unmapped, "server" matches literally in
  // the auth/controller docs where it belongs.
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
  "log-out":   "logout", // "log out from server" → auth.logout
  // NOTE: "sign" alone not mapped — "sign out" would collapse to just "sign"→"login"
  // which incorrectly surfaces auth.login. auth.logout description contains "sign out".
  signout:     "logout",
  "sign-out":  "logout",
  signoff:     "logout",
  logout:      "logout",
  out:         "logout", // "log out" → "logout"; token "out" maps to "logout"
  account:     "profile",
  user:        "profile",  // "switch user" → profile context
  switch:      "use",       // bee auth switch = bee auth use
  whoami:      "profiles",
  // NOTE: "who" not mapped to profiles — "which controller am I on" would fire auth.profiles instead of controller.current
  // controller
  master:      "controller",
  instance:    "controller",
  // NOTE: "use" not mapped to "select". It is an extremely common English verb
  // ("how do I use the --all flag") that injected controller.select into any
  // natural query containing it. The command path "auth use" already contains
  // the literal token "use", and "switch"→"use" still reaches it, so the
  // synonym only caused false pulls. See retrieval audit.
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
  install:     "setup",   // "install bee on a server" → getting-started / login
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
  // gate-recall synonyms (short queries the relevance-gate needs to match)
  cache:         "ttl",        // "how does cache work" → cache doc mentions TTL
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

/**
 * Content tokens of a query, for the relevance gate. MUST mirror the
 * tokenization in buildMatchExpr (split on non-alphanumeric, drop stopwords) so
 * the gate scores exactly the tokens that retrieval matched on. A stricter
 * length filter here would retrieve a hit on a short domain token (e.g. "ui",
 * "rm") but then score it as if the token did not exist, wrongly emptying the
 * gate for a valid query.
 */
function contentTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

/**
 * Does `token` (or its prefix) start a word in `blob`? FTS5 matches on word
 * PREFIXES ("node"* matches "node"/"nodes" but not "anode"), so the gate must
 * use the same word-start semantics. A raw substring test (blob.includes) would
 * count "node" as present in "anode" and "log" as present in "login"/"logout",
 * letting coincidental token fragments clear the gate the gate exists to block.
 */
function wordStartMatch(blob: string, token: string): boolean {
  if (token === "") return false;
  let from = 0;
  for (;;) {
    const idx = blob.indexOf(token, from);
    if (idx < 0) return false;
    const prev = idx === 0 ? "" : blob[idx - 1]!;
    // word start = at string start or preceded by a non-alphanumeric char
    if (!/[a-z0-9]/.test(prev)) return true;
    from = idx + 1;
  }
}

/**
 * How much of the query's content vocabulary is present in this item.
 * A token counts as present if it (or its synonym expansion) starts a word in
 * the item's searchable text. Returns matched/total and the ratio.
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
    if (wordStartMatch(blob, t) || wordStartMatch(blob, expandToken(t))) matched++;
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

// ─── Corpus cache (avoid rebuilding FTS5 table on every call) ────────────────

interface CorpusCache {
  db: Database;
  items: DocItem[];
}
let _corpusCache: CorpusCache | null = null;

/**
 * Get or create the cached FTS5 database for the given corpus items.
 * When the same array reference is passed, reuses the cached DB.
 */
function getCorpusDb(corpus: DocItem[]): Database {
  if (_corpusCache && _corpusCache.items === corpus) {
    return _corpusCache.db;
  }
  // Close previous cache if the corpus changed (new reference).
  if (_corpusCache) {
    try { _corpusCache.db.close(); } catch { /* ignore */ }
  }
  const db = new Database(":memory:");
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
  _corpusCache = { db, items: corpus };
  return db;
}

export function searchDocs(
  query: string,
  corpus: DocItem[],
  limit = 5,
  opts: SearchOptions = {},
): DocItem[] {
  const match = buildMatchExpr(query);
  if (match === "" || corpus.length === 0) return [];

  const db = getCorpusDb(corpus);

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

    // ── Combined promotion layer (exact path + flag + cross-plugin + expert) ─────
    const qNorm = query.toLowerCase().replace(/\s+/g, " ").trim();
    let promoted = false;

    // 1. Exact command-path promotion: query exactly equals a command's id.
    const exactIdx = items.findIndex(
      (it) => it.type === "command" && it.id.replace(/\./g, " ") === qNorm,
    );
    if (exactIdx > 0) {
      const [exact] = items.splice(exactIdx, 1);
      items.unshift(exact!);
      promoted = true;
    }

    // 2. Expert routing: query contains a `<group> <verb>` pattern matching a
    //    command id (e.g. "how to node create" or "job list"). Boosts the first
    //    matching command above non-command docs. Only fires when exact-match
    //    didn't already run, so "node create" (exact) → promotion #1,
    //    "how to node create" (inexact) → caught here.
    if (!promoted) {
      const cmdPattern = /\b([a-z]{2,})\.([a-z]{2,})\b|([a-z]{2,})\s+([a-z]{2,})\b/g;
      let cm: RegExpExecArray | null;
      while ((cm = cmdPattern.exec(qNorm)) !== null) {
        const a = cm[1] ?? cm[3]!;
        const b = cm[2] ?? cm[4]!;
        const targetId = `${a}.${b}`;
        const cmdIdx = items.findIndex(
          (it) => it.type === "command" && it.id === targetId,
        );
        if (cmdIdx > 1) {
          // Move to position 1 (right after the #1 exact match, if any).
          const [cmd] = items.splice(cmdIdx, 1);
          items.splice(1, 0, cmd!);
          promoted = true;
          break;
        }
      }
    }

    // 3. Flag-aware promotion: query phrases that imply a CLI flag.
    //    Maps natural phrases → flag name → commands whose body mentions it.
    //    Uses word-boundary regex so "label" doesn't match "labels".
    const flagPhrases: Record<string, string[]> = {
      "not just mine": ["--all"],
      everything: ["--all"],
      "all jobs": ["--all"],
      "all nodes": ["--all"],
      "specific profile": ["--profile"],
      "wait for": ["--wait"],
      timeout: ["--timeout"],
      "specific node": ["--node"],
      label: ["--labels"],
      "remote dir": ["--remote-dir"],
    };

    // Generic "X option" and "X option Y" patterns: find the flag word.
    const optionMatch = qNorm.match(/([a-z][-a-z]+)\s+option(?:\s+[a-z]+)?\b/);
    if (optionMatch) {
      const flagWord = optionMatch[1]!;
      const flagMap: Record<string, string> = {
        all: "--all",
        wait: "--wait",
        follow: "--follow",
        profile: "--profile",
        recursive: "--recursive",
        script: "--script",
        node: "--node",
        timeout: "--timeout",
        label: "--labels",
        yes: "--yes",
        store: "--store",
        description: "--description",
        shell: "--shell",
        email: "--email",
        schedule: "--schedule",
        "remote-dir": "--remote-dir",
        "cred-id": "--cred-id",
        "controlled-agent": "--controlled-agent",
        folder: "--folder",
      };
      const flag = flagMap[flagWord];
      if (flag) {
        const fi = items.findIndex(
          (it) => it.type === "command" && it.body?.includes(flag),
        );
        if (fi > (promoted ? 1 : 0)) {
          const [flagged] = items.splice(fi, 1);
          items.splice(promoted ? 1 : 0, 0, flagged!);
          promoted = true;
        }
      }
    }
    for (const [phrase, flags] of Object.entries(flagPhrases)) {
      const phraseRe = new RegExp(`\\b${phrase}\\b`, "i");
      if (phraseRe.test(qNorm)) {
        for (const flag of flags) {
          const fi = items.findIndex(
            (it) => it.type === "command" && it.body?.includes(flag),
          );
          if (fi > (promoted ? 1 : 0)) {
            const [flagged] = items.splice(fi, 1);
            items.splice(promoted ? 1 : 0, 0, flagged!);
            promoted = true;
          }
        }
      }
    }

    // 4. Cross-plugin routing: "what commands are available" → promote .list
    //    commands (job.list, node.list, cred.list) to the front.
    if (!promoted) {
      const listingRe = /\b(what|all|available)\s+commands?\b/;
      if (listingRe.test(qNorm)) {
        // Extract list commands in reverse order so splice indexes stay valid.
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i]!.type === "command" && /\.list$/.test(items[i]!.id)) {
            const [cmd] = items.splice(i, 1);
            items.unshift(cmd!);
            promoted = true;
          }
        }
      }
    }

    const gated = opts.gate
      ? items.filter((item) => passesRelevanceGate(query, item))
      : items;

    // Soft gate (opt-in via softGate): if the gate empties every hit but BM25
    // did return matches, fall back to the ungated hits. Raw `bee ask` path
    // wants this — an empty result is worse than a slightly-off hit. The LM
    // path leaves it OFF so an empty gate stays empty (no hallucination fuel).
    const final = opts.gate && opts.softGate && gated.length === 0 ? items : gated;

    return final.slice(0, limit);
}
