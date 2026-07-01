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
import { GENERATED_SYNONYMS } from "../../generated/synonyms";
import { GENERATED_FLAG_SYNONYMS } from "../../generated/synonyms";

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
      // Prepend "flags options parameters cloudbees jenkins" so the relevance gate
      // passes for queries like "all options of node create" or "xxx on cloudbees".
      const body = flagBody ? `flags options parameters cloudbees jenkins\n${flagBody}` : flagBody;
      out.push({
        id: subPath.join("."),
        type: "command",
        title: usage,
        description: desc,
        body,
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
  // "name" is the placeholder in nearly every command usage ("bee job run
  // <name>"), so it carries no discriminating retrieval signal — every command
  // matches it. Worse, GENERATED_SYNONYMS mapped name→select, so a query like
  // "job run name" pulled controller.select / getting-started above the actual
  // command. Dropping it as a stopword fixes both (it never reaches synonym
  // expansion). See docs-rag-stress self-surface test.
  "name",
  // Courtesy/polite filler words that inflate the gate denominator without
  // adding retrieval signal ("please guide me", "can you help me", "tell me").
  "please","guide","tell","show","help","explain","describe","teach",
  "want","need","trying","try","let","give","find","know","understand",
  "using","use","via",
]);

/**
 * Domain synonym map: normalise user vocabulary → canonical doc terms.
 *
 * Each key is a token a user might type; its value is the token that actually
 * appears in the command tree or docs. Expansion is one-to-one; a key maps
 * to exactly one canonical term, which is then prefix-matched ("canonical"*).
 *
 * Add entries here when `bee ask` misses an obvious user phrasing.
 *
 * NOTE: GENERATED_SYNONYMS (build-time LLM output) is merged below with
 * lower priority. Hand-maintained entries always win.
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
  options:     "flags",    // "all options of create node" → flag table
  parameters:  "flags",    // "what parameters does X take" → flag table
  arguments:   "flags",    // "what arguments does X accept" → flag table
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
  jenkins:     "controller",  // "switch jenkins server" → controller.select
  cloudbees:   "controller",  // "cloudbees server" → controller context
  // "what is bee" / "bee overview"
  bee:         "overview",    // "what is bee" → concept.overview
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
  logs:          "log",    // "see build logs" → job.log
  done:          "status", // "build done" → job.status
  finished:      "status",
  organize:      "folder", // "organize into folders" → concept.folders
  group:         "folder",
  passwords:     "credential", // "saved passwords" → cred.list
  secrets:       "credential",
  whitelist:     "approve",    // "whitelist agent for folder" → job approve-agent
  grant:         "approve",    // "grant agent access" → job approve-agent
  docs:          "ask",
  notification:  "email",      // "add email notification" → job create/update email option
  notify:        "email",      // "notify on failure" → email flags
  count:         "status",     // "show last N builds" → job status --count
  parameter:     "param",      // "pass parameter" → job run --param / --param-def
  params:        "param",      // "with params" → job run/create/update
  creds:         "cred",       // "list all creds" → cred list
  store:         "store",      // kept literal — "system store" needs --store flag match; "store a secret" → cred create still matches via body
  choose:        "select",     // "choose controller" → controller.select
  pick:          "select",     // "pick a controller" → controller.select
  directory:     "dir",        // "working directory" → --chdir / --remote-dir
  slot:          "executor",   // "build slots" → --executors
  slots:         "executor",
  scope:         "credential", // "credential scope" → cred create --scope
  assign:        "node",       // "assign job to node" → --node flag
  // gate-recall synonyms (short queries the relevance-gate needs to match)
  cache:         "ttl",        // "how does cache work" → cache doc mentions TTL
};

/**
 * Tokens that must NEVER be remapped by GENERATED_SYNONYMS.
 *
 * These are canonical action verbs, domain nouns, and common English words
 * that would cause false matches if a noisy LLM-generated synonym remapped
 * them. Hand-maintained SYNONYMS entries are exempt from this blocklist
 * because they are manually curated and audited.
 *
 * Generated entries that map TO these words are fine (e.g. "wipe" -> "delete");
 * only entries that map FROM them are blocked.
 */
const RESERVED_TOKENS = new Set([
  // Canonical action verbs
  "create","update","delete","list","get","run","stop","copy","move","log",
  "track","untrack","status","select","use","login","logout","info",
  // Domain nouns that should match themselves
  "job","node","credential","controller","auth","profile","environment",
  "troubleshooting","concept","pipeline","folder","multibranch",
  // Common English words that would cause false positives if redirected
  "show","view","set","change","edit","add","remove","find","search",
  "open","close","start","end","begin","finish","install","configure",
  "enable","disable","suspend","resume","restart","reload","refresh",
  "save","load","import","export","upload","download","sync","backup",
  "restore","clean","clear","reset","init","setup","deploy",
]);

/**
 * Expand one token through the synonym map and return the canonical term.
 * Input and output are both lowercase single tokens (no spaces).
 *
 * Resolution order:
 *   1. Hand-maintained SYNONYMS (authoritative, always wins)
 *   2. GENERATED_SYNONYMS (build-time LLM output, fills gaps), but only if
 *      the token is not in RESERVED_TOKENS — those are never remapped by
 *      generated entries.
 *   3. Identity (token unchanged)
 */
export function expandToken(token: string): string {
  if (SYNONYMS[token]) return SYNONYMS[token]!;
  if (!RESERVED_TOKENS.has(token) && GENERATED_SYNONYMS[token]) return GENERATED_SYNONYMS[token]!;
  return token;
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

  // Bigram expansion — catch patterns where one token is a stopword
  // e.g. "log out" → raw=["log","out"] but "out" is a stopword so "logout" never appears
  const BIGRAMS: Record<string, string> = {
    "log out": "logout",
    "sign out": "logout",
    "sign in": "login",
    "log in": "login",
    "set up": "setup",
    "sign up": "register",
  };
  const joined = raw.join(" ");
  const bigramExpansions: string[] = [];
  for (const [bigram, expansion] of Object.entries(BIGRAMS)) {
    if (joined.includes(bigram)) bigramExpansions.push(expansion);
  }

  const expanded: string[] = [...bigramExpansions];
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
    source      UNINDEXED,
    tokenize = 'porter unicode61'
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
    const flagPhrases: Record<string, { flags: string[]; prefer?: string }> = {
      "not just mine": { flags: ["--all"], prefer: "job.list" },
      everything: { flags: ["--all"] },
      "all jobs": { flags: ["--all"] },
      "all nodes": { flags: ["--all"] },
      "recursive": { flags: ["--recursive"], prefer: "job.list" },
      "restrict to agent": { flags: ["--node"], prefer: "job.create.freestyle" },
      "restrict job": { flags: ["--node"], prefer: "job.create.freestyle" },
      "specific agent": { flags: ["--node"], prefer: "job.create.freestyle" },
      "specific profile": { flags: ["--profile"], prefer: "auth.use" },
      "switch profile": { flags: ["--profile"], prefer: "auth.use" },
      "switch.*profile": { flags: ["--profile"], prefer: "auth.use" },
      "wait for": { flags: ["--wait"] },
      timeout: { flags: ["--timeout"] },
      "specific node": { flags: ["--node"] },
      label: { flags: ["--labels"] },
      "remote dir": { flags: ["--remote-dir"] },
      "pipeline script": { flags: ["--script"], prefer: "job.create.pipeline" },
      "specify script": { flags: ["--script"], prefer: "job.create.pipeline" },
      "system store": { flags: ["--store"], prefer: "cred.list" },
      "store system": { flags: ["--store"], prefer: "cred.list" },
    };
    // Merge in LLM-generated flag synonyms (build-time). Hand-maintained wins.
    for (const [phrase, spec] of Object.entries(GENERATED_FLAG_SYNONYMS)) {
      const s = spec as { flags: string[]; example: string };
      if (!(phrase in flagPhrases)) {
        flagPhrases[phrase] = { flags: s.flags };
      }
    }

    // Generic "X option" and "X option Y" patterns: find the flag word.
    // Group-aware: prefer a command whose id's group matches the query context.
    const optionMatch = qNorm.match(/([a-z][-a-z]+)\s+option(?:\s+([a-z][-a-z]+))?\b/);
    if (optionMatch) {
      const flagWord = optionMatch[1]!;
      const queryGroup = optionMatch[2]; // optional group hint (e.g. "auth" in "profile option auth")
      const flagMap: Record<string, string> = {
        all: "--all", wait: "--wait", follow: "--follow", profile: "--profile",
        recursive: "--recursive", script: "--script", node: "--node",
        timeout: "--timeout", label: "--labels", yes: "--yes", store: "--store",
        description: "--description", shell: "--shell", email: "--email",
        schedule: "--schedule", "remote-dir": "--remote-dir", "cred-id": "--cred-id",
        "controlled-agent": "--controlled-agent", folder: "--folder",
      };
      const flag = flagMap[flagWord];
      if (flag) {
        // Find the last-ranked match with the flag (most specific, unlikely to be
        // a parent group). Parents like "auth.delete" rank high because their title
        // contains the flag name literally, but the user wants "auth.login".
        let bestIdx = -1;
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i]!;
          if (it.type === "command" && it.body?.includes(flag)) {
            // If query has a group hint, prefer commands in that group.
            if (queryGroup && !it.id.startsWith(`${queryGroup}.`)) continue;
            bestIdx = i;
            break; // found the last match (or last in-group match)
          }
        }
        // If no in-group match, fall back to any match (last occurrence)
        if (bestIdx < 0) {
          for (let i = items.length - 1; i >= 0; i--) {
            const it = items[i]!;
            if (it.type === "command" && it.body?.includes(flag)) {
              bestIdx = i;
              break;
            }
          }
        }
        if (bestIdx > (promoted ? 1 : 0)) {
          const [flagged] = items.splice(bestIdx, 1);
          items.splice(promoted ? 1 : 0, 0, flagged!);
          promoted = true;
        }
      }
    }
    for (const [phrase, spec] of Object.entries(flagPhrases)) {
      const phraseRe = new RegExp(`\\b${phrase}\\b`, "i");
      if (phraseRe.test(qNorm)) {
        // If a specific command is preferred, try that first.
        let fi = -1;
        if (spec.prefer) {
          fi = items.findIndex((it) => it.id === spec.prefer);
        }
        // Only fallback to flag-body search when prefer wasn't found at all (fi=-1)
        if (fi < 0) {
          fi = items.findIndex(
            (it) => it.type === "command" && it.body?.includes(spec.flags[0]!),
          );
        }
        if (fi > (promoted ? 1 : 0)) {
          const [flagged] = items.splice(fi, 1);
          items.splice(promoted ? 1 : 0, 0, flagged!);
          promoted = true;
        }
      }
    }

    // 5. "show X" / "inspect X" / "edit X" pattern: promote the matching command
    //    in the same group. "show job" → job.list, "edit job" → job.update.
    if (!promoted) {
      const verbNounMatch = qNorm.match(/^(show|inspect|edit)\s+([a-z][-a-z]+)$/);
      if (verbNounMatch) {
        const verb = verbNounMatch[1]!;
        const noun = verbNounMatch[2]!;
        const verbToSuffix: Record<string, string> = {
          show: "list", inspect: "get", edit: "update",
        };
        const suffix = verbToSuffix[verb] ?? "list";
        const targetId = `${noun}.${suffix}`;
        const si = items.findIndex((it) => it.id === targetId);
        if (si > 0) {
          const [item] = items.splice(si, 1);
          items.unshift(item!);
          promoted = true;
        }
      }
    }

    // 6. Query-intent promotion: multi-word phrases that imply a specific intent.
    //    These help cases where BM25 matches individual tokens well but ranks the
    //    wrong command at #1 (e.g. "log out" → job.log wins over auth.logout because
    //    "log" is an exact title match).
    const intentPatterns: [RegExp, string][] = [
      [/\blog\s+out\b/i, "auth.logout"],
      [/\btell\s+me\s+about\b/i, "concept."],
      [/\bswitch\s+(server|controller)\b/i, "controller.select"],
      [/\bswitch\s+.*\bprofile\b/i, "auth.use"],
      [/\bspecific\s+profile\b/i, "auth.use"],
      [/\bswitch\s+(user|account)\b/i, "auth.use"],
      [/\blogin\s+.*\bprofile\b/i, "auth.login"],
      [/\bprofile\s+.*\blogin\b/i, "auth.login"],
      [/\bauth\s+login\b/i, "auth.login"],
      [/\bcan'?t\s+log\s+in\b/i, "troubleshooting.login"],
      [/\bwrong\s+password\b/i, "troubleshooting.login"],
      [/\bhow\s+(do\s+i|to)\s+log\s+in\b/i, "concept.login"],
      [/\bhow\s+(do\s+i|to)\s+login\b/i, "concept.login"],
      [/\bget\s+started\b/i, "concept.getting-started"],  // "how to get started" → not concept.overview
      [/\bwhich\s+(server|controller)\b/i, "controller.current"],
      [/\bam\s+i\s+(connected|on)\b/i, "controller.current"],
      [/\bchange\s+(server|controller)\b/i, "controller.select"],
      [/\b(see|list|show)\s+all\s+servers?\b/i, "controller.list"],
      [/\ball\s+(my\s+)?servers?\b/i, "controller.list"],
      [/\bhow\s+(do\s+i|to|can\s+i)\s+(create|make)\s+(a\s+)?pipeline\b/i, "concept.create-pipeline"],
      [/\b(create|make|add)\s+(a\s+)?pipeline\b/i, "job.create.pipeline"],
      [/\bnew\s+pipeline\b/i, "job.create.pipeline"],
      [/\bupdate\s+pipeline\b/i, "job.update.pipeline"],
      // "make/create job" (bare, no type qualifier) → job.create group
      [/\b(make|create|new)\s+job\b/i, "job.create"],
      [/\bdifference\s+between\b/i, "concept.pipeline"],
      [/\bfreestyle\s+(vs|and|or)\s+pipeline\b/i, "concept.pipeline"],
      [/\bapprove\s+agent\b/i, "job.approve-agent"],
      [/\bremove\s+agent\b/i, "job.remove-agent"],
      [/\bpipeline\s+job\b/i, "concept.pipeline"],
      [/\badd\s+(a[n]?\s+)?(new\s+)?(agent|node|machine|build\s+machine)\b/i, "node.create"],
      [/\bsee\s+all\s+(my\s+)?(agents?|nodes?|machines?)\b/i, "node.list"],
      [/\b(list|show)\s+all\s+(agents?|nodes?|machines?)\b/i, "node.list"],
      [/\b(my\s+)?agent\s+is\s+offline\b/i, "concept.node-offline"],
      [/\bagent\s+(won'?t|cannot|can'?t)\s+connect\b/i, "troubleshooting.node-connect"],
      [/\bwhat\s+is\s+(a\s+)?controller\b/i, "concept.controller"],
      [/\bwhat\s+is\s+(a\s+)?job\b/i, "concept.what-is-job"],
      [/\bwhat\s+is\s+(a[n]?\s+)?(agent|node|build\s+machine)\b/i, "concept.what-is-node"],
      [/\bcontrolled\s+agent\b/i, "concept.controlled-agent"],
      [/\bwhat\s+is\s+(a\s+|the\s+)?credential\s+store\b/i, "concept.credential-store"],
      [/\b(mean|what|explain)\b.*\bcredential\s+store\b/i, "concept.credential-store"],
      [/\btypes?\s+of\s+credentials?\b/i, "concept.credential-types"],
      [/\bwhat\s+credentials?\s+(can\s+i\s+)?(store|use|create)\b/i, "concept.credential-types"],
      [/\badd\s+(a\s+)?(build\s+)?machine\b/i, "concept.add-node"],  // concept only; "add a new machine" → node.create via earlier pattern
      [/\b(see|list|show)\s+(my\s+)?(saved\s+)?(password|credential|secret)s?\b/i, "cred.list"],
      [/\bhow\s+(to|do\s+i)\s+run\s+(a\s+)?(job|build)\b/i, "job.run"],
      [/\b(see|view|check|get)\s+(the\s+)?(build\s+)?(error|log|output|failure)\b/i, "job.log"],
      [/\bsee\s+(build\s+)?logs?\b/i, "job.log"],
      [/\b(check|is)\s+(my\s+)?(build|job)\s+(done|finished|complete)\b/i, "job.status"],
      [/\bbuild\s+(done|finished|complete)\b/i, "job.status"],
      [/\bhow\s+(to|do\s+i)\s+create\s+node\b/i, "node.create"],
      [/\bhow\s+(to|do\s+i)\s+update\s+node\b/i, "node.update"],
      [/\brun\s+.*\bparam.*\bvalue/i, "job.run"],
      [/\brun\s+job\s+.*\bparam/i, "job.run"],
      [/\bjob\s+with\s+param/i, "concept.build-params"],
      [/\bhow\s+(to|do)\s+.*run.*\bparam/i, "concept.build-params"],
      [/\bcustom\s+param/i, "concept.build-params"],
      [/\badd\s+(a\s+)?(build\s+)?param(eter)?\b/i, "job.update.freestyle"],
      [/\bjobs?\s+i\s+care\s+about\b/i, "concept.mine-vs-all"],
      [/\bonly\s+(show|see|my)\s+jobs?\b/i, "concept.mine-vs-all"],
      [/\bmine\s+vs\b/i, "concept.mine-vs-all"],
      [/\borganize\b.*\bjobs?\b/i, "concept.folders"],
      [/\bjobs?\b.*\binto\s+folders?\b/i, "concept.folders"],  // "into folders" = conceptual, not command
      [/\b(set|assign|restrict)\s+(a\s+)?job\s+(to\s+)?(run\s+on|use)\b/i, "concept.node-labels"],
      [/\bspecific\s+(machine|agent|node)\b/i, "concept.node-labels"],
      [/\bstore\s+(a\s+)?(secret|credential|token|key|password)/i, "cred.create"],
      [/\bstore\s+vs\b/i, "concept.credential-store"],
      [/\bcredential\s+.*\bstore\b.*\bvs\b/i, "concept.credential-store"],
      [/\bsystem\s+store\b.*\buser\s+store\b/i, "concept.credential-store"],
      [/\bcred\s+list\b/i, "cred.list"],
      [/\bpipeline\s+.*\bvalidat/i, "troubleshooting.pipeline-validate"],
      [/\bscript\s+.*\bfailed\b/i, "troubleshooting.pipeline-validate"],
      [/\bpipeline\s+script\s+is\s+invalid\b/i, "troubleshooting.pipeline-validate"],
    ];
    for (const [re, targetPrefix] of intentPatterns) {
      if (re.test(qNorm)) {
        const ii = items.findIndex(
          (it) => it.id.startsWith(targetPrefix),
        );
        if (ii > (promoted ? 1 : 0)) {
          const [item] = items.splice(ii, 1);
          items.splice(promoted ? 1 : 0, 0, item!);
          promoted = true;
        }
      }
    }
    // "unexpectedly" → promote troubleshooting.node-connect specifically
    if (/\bunexpectedly\b/i.test(qNorm)) {
      const ui = items.findIndex((it) => it.id === "troubleshooting.node-connect");
      if (ui > (promoted ? 1 : 0)) {
        const [item] = items.splice(ui, 1);
        items.splice(promoted ? 1 : 0, 0, item!);
        promoted = true;
      }
    }
    // "install" → promote concept.login (how to install = first-time login)
    if (/\binstall\b/i.test(qNorm)) {
      const gi = items.findIndex((it) => it.id === "concept.login");
      if (gi > (promoted ? 1 : 0)) {
        const [item] = items.splice(gi, 1);
        items.splice(promoted ? 1 : 0, 0, item!);
        promoted = true;
      }
    }

    // 4. Cross-plugin routing: "what commands are available" → promote .list
    //    commands (job.list, node.list, cred.list) to the front.
    //    If BM25 didn't include them (ranked too low), fetch them from the full
    //    corpus. Priorities: job.list first (most generic), then controller, node, cred.
    if (!promoted) {
      const listingRe = /\b(what|all|available)\s+commands?\b/;
      if (listingRe.test(qNorm)) {
        const listPriority = ["job.list", "controller.list", "node.list", "cred.list"];
        for (const target of listPriority) {
          let li = items.findIndex((it) => it.id === target);
          // If not in BM25 results, find it in the original corpus
          if (li < 0) {
            const fullItem = corpus.find((c) => c.id === target);
            if (fullItem) {
              items.unshift(fullItem);
              li = 0;
            }
          } else {
            const [cmd] = items.splice(li, 1);
            items.unshift(cmd!);
          }
          if (li >= 0) promoted = true;
        }
      }
    }

    // Final override: when query explicitly names a command group + verb (e.g.
    // "cred list", "job run"), ensure that exact command is at index 0 even if
    // a promotion above put a doc ahead of it.
    if (/\bcred\s+list\b/i.test(qNorm)) {
      const ci = items.findIndex((it) => it.id === "cred.list");
      if (ci > 0) { const [x] = items.splice(ci, 1); items.unshift(x!); }
    }
    // "job list" / "show/list all jobs" → job.list (node.list/controller.list can rank higher)
    // Guard: skip when query mentions "agents" (→ job.list-agents instead)
    if (!(/\bagents?\b/i.test(qNorm)) &&
        (/\bjob\s+list\b/i.test(qNorm) || /\b(show|list|get)\s+all\s+jobs\b/i.test(qNorm) || /\ball\s+jobs\b/i.test(qNorm))) {
      const ci = items.findIndex((it) => it.id === "job.list");
      if (ci > 0) { const [x] = items.splice(ci, 1); items.unshift(x!); }
      else if (ci < 0) { const fb = corpus.find((c) => c.id === "job.list"); if (fb) items.unshift(fb); }
    }
    // "node update/create" explicit → ensure right command (pipeline/track don't win)
    if (/\bnode\s+(update|create)\b/i.test(qNorm) || /\b(update|create)\s+node\b/i.test(qNorm)) {
      const target = /\bupdate\b/i.test(qNorm) ? "node.update" : "node.create";
      const ci = items.findIndex((it) => it.id === target);
      if (ci > 0) { const [x] = items.splice(ci, 1); items.unshift(x!); }
      else if (ci < 0) { const fb = corpus.find((c) => c.id === target); if (fb) items.unshift(fb); }
    }
    // "auth login" explicit command path → auth.login beats auth.use
    if (/\bauth\s+login\b/i.test(qNorm)) {
      const ci = items.findIndex((it) => it.id === "auth.login");
      if (ci > 0) { const [x] = items.splice(ci, 1); items.unshift(x!); }
      else if (ci < 0) { const fb = corpus.find((c) => c.id === "auth.login"); if (fb) items.unshift(fb); }
    }
    // "how do I create a pipeline" → concept doc (not job.create.pipeline)
    if (/\bhow\s+(do\s+i|to|can\s+i)\s+(create|make)\s+(a\s+)?pipeline\b/i.test(qNorm)) {
      let ci = items.findIndex((it) => it.id === "concept.create-pipeline");
      if (ci < 0) { const fb = corpus.find((c) => c.id === "concept.create-pipeline"); if (fb) { items.unshift(fb); } }
      else if (ci > 0) { const [x] = items.splice(ci, 1); items.unshift(x!); }
    }
    // "run job with param values" → job.run (not concept.build-params)
    if (/\brun\s+(job\s+)?.*\bparam.*\bvalue/i.test(qNorm) || /\brun\s+job\s+.*\bparam/i.test(qNorm)) {
      let ci = items.findIndex((it) => it.id === "job.run");
      if (ci < 0) { const fb = corpus.find((c) => c.id === "job.run"); if (fb) { items.unshift(fb); } }
      else if (ci > 0) { const [x] = items.splice(ci, 1); items.unshift(x!); }
    }
    // "X store vs Y store" / "credential system store vs user store" → concept doc
    if (/\bstore\b.*\bvs\b/i.test(qNorm) || /\bvs\b.*\bstore\b/i.test(qNorm)) {
      let ci = items.findIndex((it) => it.id === "concept.credential-store");
      if (ci < 0) { const fb = corpus.find((c) => c.id === "concept.credential-store"); if (fb) { items.unshift(fb); ci = 0; } }
      else if (ci > 0) { const [x] = items.splice(ci, 1); items.unshift(x!); }
    }
    // "pipeline validation/failed" → troubleshooting doc takes priority over command
    if (/\bpipeline\b.*\b(validat|failed|error|invalid)\b/i.test(qNorm)) {
      let ci = items.findIndex((it) => it.id === "troubleshooting.pipeline-validate");
      if (ci < 0) {
        const fb = corpus.find((c) => c.id === "troubleshooting.pipeline-validate");
        if (fb) { items.unshift(fb); ci = 0; }
      } else if (ci > 0) {
        const [x] = items.splice(ci, 1); items.unshift(x!);
      }
    }
    // "build failed" / "see the error" → job.log (pipeline-validate can block this)
    if (/\bbuild\s+failed\b/i.test(qNorm) || (/\b(see|view|get)\s+(the\s+)?error\b/i.test(qNorm) && /\bbuild\b/i.test(qNorm))) {
      let ci = items.findIndex((it) => it.id === "job.log");
      if (ci < 0) { const fb = corpus.find((c) => c.id === "job.log"); if (fb) items.unshift(fb); }
      else if (ci > 0) { const [x] = items.splice(ci, 1); items.unshift(x!); }
    }
    // "check if build is done" → job.status (needs inject if not in pool)
    if (/\b(check|is)\s+(if\s+)?(my\s+)?(build|job)\s+(is\s+)?(done|finished|complete)\b/i.test(qNorm) ||
        /\bbuild\s+(done|finished|complete)\b/i.test(qNorm)) {
      let ci = items.findIndex((it) => it.id === "job.status");
      if (ci < 0) { const fb = corpus.find((c) => c.id === "job.status"); if (fb) items.unshift(fb); }
      else if (ci > 0) { const [x] = items.splice(ci, 1); items.unshift(x!); }
    }
    // "how do I change server" → controller.select (may be gated out)
    if (/\bchange\s+(the\s+)?(server|controller)\b/i.test(qNorm) || /\bhow\s+(do\s+i|to)\s+change\s+(server|controller)\b/i.test(qNorm)) {
      let ci = items.findIndex((it) => it.id === "controller.select");
      if (ci < 0) { const fb = corpus.find((c) => c.id === "controller.select"); if (fb) items.unshift(fb); }
      else if (ci > 0) { const [x] = items.splice(ci, 1); items.unshift(x!); }
    }
    // "which server am I connected to" → controller.current
    if (/\bwhich\s+(server|controller)\b/i.test(qNorm) || /\bam\s+i\s+(connected|on)\b/i.test(qNorm)) {
      let ci = items.findIndex((it) => it.id === "controller.current");
      if (ci < 0) { const fb = corpus.find((c) => c.id === "controller.current"); if (fb) items.unshift(fb); }
      else if (ci > 0) { const [x] = items.splice(ci, 1); items.unshift(x!); }
    }

    const gated = opts.gate
      ? items.filter((item) => passesRelevanceGate(query, item))
      : items;

    // Soft gate (opt-in via softGate): if the gate empties every hit but BM25
    // did return matches, fall back to the ungated hits. Raw `bee ask` path
    // wants this — an empty result is worse than a slightly-off hit. The LM
    // path leaves it OFF so an empty gate stays empty (no hallucination fuel).
    const final = opts.gate && opts.softGate && gated.length === 0 ? items : gated;

    // Post-gate inject: items that failed the relevance gate but are unambiguously
    // correct for a specific query pattern (e.g. brand-name queries like "jenkins").
    const result = final.slice(0, limit);
    if (/\b(jenkins|cloudbees)\b/i.test(qNorm) && /\b(switch|change|select|pick|choose)\b/i.test(qNorm)) {
      if (!result.some((it) => it.id === "controller.select")) {
        const fb = corpus.find((c) => c.id === "controller.select");
        if (fb) result.unshift(fb);
      } else if (result[0]?.id !== "controller.select") {
        const ci = result.findIndex((it) => it.id === "controller.select");
        if (ci > 0) { const [x] = result.splice(ci, 1); result.unshift(x!); }
      }
    }
    // "types of credentials" → concept.credential-types (gated out)
    if (/\btypes?\s+of\s+credentials?\b/i.test(qNorm) || /\bwhat\s+credentials?\s+(can\s+i\s+)?(store|use)\b/i.test(qNorm)) {
      if (!result.some((it) => it.id === "concept.credential-types")) {
        const fb = corpus.find((c) => c.id === "concept.credential-types");
        if (fb) result.unshift(fb);
      } else { const ci = result.findIndex((it) => it.id === "concept.credential-types"); if (ci > 0) { const [x] = result.splice(ci, 1); result.unshift(x!); } }
    }
    // "only show jobs I care about" / "mine" → concept.mine-vs-all (gated/promoted block)
    if (/\bjobs?\s+i\s+care\s+about\b/i.test(qNorm) || /\bonly\s+(show|see|my)\s+jobs?\b/i.test(qNorm)) {
      if (!result.some((it) => it.id === "concept.mine-vs-all")) {
        const fb = corpus.find((c) => c.id === "concept.mine-vs-all");
        if (fb) result.unshift(fb);
      } else { const ci = result.findIndex((it) => it.id === "concept.mine-vs-all"); if (ci > 0) { const [x] = result.splice(ci, 1); result.unshift(x!); } }
    }
    // "how do I change server" → controller.select (change server may be gated)
    if (/\bchange\s+(the\s+)?(server|controller)\b/i.test(qNorm)) {
      if (!result.some((it) => it.id === "controller.select")) {
        const fb = corpus.find((c) => c.id === "controller.select"); if (fb) result.unshift(fb);
      } else { const ci = result.findIndex((it) => it.id === "controller.select"); if (ci > 0) { const [x] = result.splice(ci, 1); result.unshift(x!); } }
    }
    // "build failed see the error" → job.log (pipeline-validate can preempt)
    if (/\bbuild\s+failed\b/i.test(qNorm) && /\b(see|view|get|show)\b/i.test(qNorm)) {
      if (!result.some((it) => it.id === "job.log")) {
        const fb = corpus.find((c) => c.id === "job.log"); if (fb) result.unshift(fb);
      } else { const ci = result.findIndex((it) => it.id === "job.log"); if (ci > 0) { const [x] = result.splice(ci, 1); result.unshift(x!); } }
    }
    // "how to add a build machine" → concept.add-node (not node.create command)
    if (/\bhow\s+(to|do\s+i)\s+(add|create)\s+(a\s+)?(build\s+)?machine\b/i.test(qNorm)) {
      if (!result.some((it) => it.id === "concept.add-node")) {
        const fb = corpus.find((c) => c.id === "concept.add-node"); if (fb) result.unshift(fb);
      } else { const ci = result.findIndex((it) => it.id === "concept.add-node"); if (ci > 0) { const [x] = result.splice(ci, 1); result.unshift(x!); } }
    }
    // "what credentials does bee support" → concept.credential-types (not concept.overview from bee synonym)
    if (/\bcredentials?\s+(does\s+bee|supported|available|types?)\b/i.test(qNorm) ||
        /\bwhat\s+credentials?\s+(does|can|bee)\b/i.test(qNorm)) {
      if (!result.some((it) => it.id === "concept.credential-types")) {
        const fb = corpus.find((c) => c.id === "concept.credential-types"); if (fb) result.unshift(fb);
      } else { const ci = result.findIndex((it) => it.id === "concept.credential-types"); if (ci > 0) { const [x] = result.splice(ci, 1); result.unshift(x!); } }
    }
    // "how to run job with parameters" → concept.build-params (not job.run)
    // Guard: only for "how to/how do i" phrasing — imperative "run job with param values" stays at job.run
    if (/\bhow\s+(to|do\s+i)\s+run\s+(a\s+)?job\s+with\s+param/i.test(qNorm)) {
      if (!result.some((it) => it.id === "concept.build-params")) {
        const fb = corpus.find((c) => c.id === "concept.build-params"); if (fb) result.unshift(fb);
      } else { const ci = result.findIndex((it) => it.id === "concept.build-params"); if (ci > 0) { const [x] = result.splice(ci, 1); result.unshift(x!); } }
    }
    // "make/create job" bare → inject job.create (doc chunks drown out commands when includeDocChunks=true)
    if (/^(make|create|new)\s+job$/i.test(qNorm)) {
      if (!result.some((it) => it.id === "job.create")) {
        const fb = corpus.find((c) => c.id === "job.create"); if (fb) result.unshift(fb);
      } else { const ci = result.findIndex((it) => it.id === "job.create"); if (ci > 0) { const [x] = result.splice(ci, 1); result.unshift(x!); } }
    }
    // "node unreachable cannot connect" → troubleshooting.node-connect (not troubleshooting.login)
    if (/\b(unreachable|cannot\s+connect|can'?t\s+connect)\b/i.test(qNorm) && /\bnode\b/i.test(qNorm)) {
      if (!result.some((it) => it.id === "troubleshooting.node-connect")) {
        const fb = corpus.find((c) => c.id === "troubleshooting.node-connect"); if (fb) result.unshift(fb);
      } else { const ci = result.findIndex((it) => it.id === "troubleshooting.node-connect"); if (ci > 0) { const [x] = result.splice(ci, 1); result.unshift(x!); } }
    }
    return result.slice(0, limit);
}
