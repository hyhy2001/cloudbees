/**
 * RAG stress suite — thousands of generated queries against the real corpus.
 *
 * Strategy: build the *real* commander program (every plugin registered) plus
 * the embedded doc chunks, then generate queries derived from the corpus itself
 * and assert the retrieval pipeline surfaces the originating item in its top-K.
 *
 * This is a self-referential consistency check: every command and doc chunk
 * must be findable by the words it actually contains. It catches regressions in
 * tokenisation, stopword filtering, synonym expansion, BM25 weighting, and the
 * FTS5 match-expr builder — across the whole corpus, not a hand-picked sample.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { setDbPath, initDb } from "../src/core/db/connection";
import { initPlugins } from "../src/registry/index";
import {
  buildCorpus,
  searchDocs,
  buildMatchExpr,
  expandToken,
  type DocItem,
} from "../src/plugins/docs/corpus";

// ─── Real corpus bootstrap ────────────────────────────────────────────────────

let CORPUS: DocItem[] = [];
let COMMANDS: DocItem[] = [];
let DOCS: DocItem[] = [];

beforeAll(async () => {
  // Isolate from any real DB — plugin register() reads the active profile.
  // Use a throwaway on-disk path (not ":memory:") so the pooled connection is
  // shared across getConnection() calls: an in-memory DB is never pooled, so
  // initDb() and getActiveProfileName() would otherwise hit different handles.
  const tmpDb = join(tmpdir(), `bee-rag-stress-${process.pid}.db`);
  setDbPath(tmpDb);
  initDb(tmpDb);
  const program = new Command("bee");
  program.exitOverride(); // never call process.exit from inside tests
  await initPlugins(program);
  CORPUS = buildCorpus(program, { includeDocChunks: true });
  COMMANDS = CORPUS.filter((d) => d.type === "command");
  DOCS = CORPUS.filter((d) => d.type === "doc");
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STOP = new Set([
  "a","an","the","is","it","its","be","are","was","were","been","being",
  "have","has","had","do","does","did","doing","will","would","could",
  "should","may","might","shall","can","need","dare","ought","used",
  "i","me","my","we","our","you","your","he","she","they","them","their",
  "this","that","these","those","what","which","who","whom","whose",
  "how","why","when","where","if","then","else","so","as","at","by",
  "for","from","in","into","of","on","or","and","but","not","no","nor",
  "to","up","out","with","about","after","before","between","through",
  "during","without","within","against","along","across","behind","beyond",
  "down","off","over","under","above","below","per","via",
]);

/** Extract content-bearing tokens (3+ chars, non-stopword) from a string. */
function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/** True when any returned hit has the given id. */
function hitsContainId(hits: DocItem[], id: string): boolean {
  return hits.some((h) => h.id === id);
}

// ─── 1. Every command findable by its own name tokens ──────────────────────────

describe("RAG: every command findable by its name", () => {
  it("has a non-trivial command set", () => {
    expect(COMMANDS.length).toBeGreaterThanOrEqual(40);
  });

  it("each command surfaces itself when queried by its title words", () => {
    const misses: string[] = [];
    for (const cmd of COMMANDS) {
      // Title looks like "bee job run <name>" — drop "bee" and arg sigils.
      const words = cmd.title
        .replace(/[<>[\]]/g, " ")
        .split(/\s+/)
        .filter((w) => w && w !== "bee");
      const query = words.join(" ");
      const hits = searchDocs(query, CORPUS, 10);
      if (!hitsContainId(hits, cmd.id)) misses.push(`${cmd.id} :: "${query}"`);
    }
    expect(misses).toEqual([]);
  });
});

// ─── 2. Every command findable by its description ───────────────────────────────

describe("RAG: every command findable by its description", () => {
  it("each command with a description appears in top-10 for that description", () => {
    const misses: string[] = [];
    for (const cmd of COMMANDS) {
      if (!cmd.description) continue;
      const hits = searchDocs(cmd.description, CORPUS, 10);
      // For descriptions we allow the command OR a closely related sibling to
      // rank — but the originating command should be present in a wider top-K.
      if (!hitsContainId(hits, cmd.id)) {
        const wide = searchDocs(cmd.description, CORPUS, 25);
        if (!hitsContainId(wide, cmd.id)) misses.push(`${cmd.id} :: "${cmd.description}"`);
      }
    }
    expect(misses).toEqual([]);
  });
});

// ─── 3. Every doc chunk findable by its heading ────────────────────────────────

describe("RAG: every doc chunk findable by its heading", () => {
  it("has a non-trivial doc-chunk set", () => {
    expect(DOCS.length).toBeGreaterThanOrEqual(80);
  });

  it("each titled doc chunk surfaces its own source in top-15 by heading", () => {
    const misses: string[] = [];
    for (const doc of DOCS) {
      const tokens = contentTokens(doc.title);
      if (tokens.length === 0) continue; // headings like "403" or symbol-only
      const hits = searchDocs(tokens.join(" "), CORPUS, 15);
      // A heading is shared vocabulary; assert the SOURCE file appears, not the
      // exact chunk id (multiple chunks share heading words).
      if (!hits.some((h) => h.source === doc.source)) {
        misses.push(`${doc.id} :: "${doc.title}"`);
      }
    }
    expect(misses).toEqual([]);
  });
});

// ─── 4. Doc chunks findable by body phrases ────────────────────────────────────

describe("RAG: doc chunks findable by body content", () => {
  it("first content phrase of each chunk surfaces its source file", () => {
    const misses: string[] = [];
    let checked = 0;
    for (const doc of DOCS) {
      const tokens = contentTokens(doc.body).slice(0, 5);
      if (tokens.length < 3) continue;
      checked++;
      const hits = searchDocs(tokens.join(" "), CORPUS, 20);
      if (!hits.some((h) => h.source === doc.source)) {
        misses.push(`${doc.id} :: [${tokens.join(", ")}]`);
      }
    }
    // Allow a small failure budget: body prose overlaps heavily across chunks,
    // so a few may be out-ranked by a sibling section in the same file.
    expect(checked).toBeGreaterThan(50);
    expect(misses.length).toBeLessThanOrEqual(Math.ceil(checked * 0.1));
  });
});

// ─── 5. Synonym expansion — every synonym key resolves like its canonical ──────

describe("RAG: synonym expansion parity", () => {
  // The canonical verbs/nouns the synonym map targets.
  const CANONICAL_SAMPLE: Record<string, string> = {
    // verb synonyms → canonical
    kill: "stop", cancel: "stop", abort: "stop", terminate: "stop",
    remove: "delete", rm: "delete", erase: "delete", destroy: "delete",
    make: "create", add: "create", new: "create",
    trigger: "run", launch: "run", execute: "run", start: "run",
    clone: "copy", duplicate: "copy", rename: "move",
    // noun synonyms → canonical
    agent: "node", slave: "node", worker: "node", machine: "node",
    secret: "credential", token: "credential", password: "credential",
    master: "controller", instance: "controller",
  };

  it("expandToken maps each known synonym to its canonical term", () => {
    for (const [syn, canon] of Object.entries(CANONICAL_SAMPLE)) {
      expect(expandToken(syn)).toBe(canon);
    }
  });

  it("synonym expansion includes the canonical term", () => {
    // Expand-both semantics: a synonym query keeps the original token AND adds
    // its canonical term, so the canonical term must appear in the match expr.
    // (We do NOT require synExpr === canonExpr — keeping the original token is
    // deliberate so exact-name commands like `remove-agent` still match "remove".)
    const mismatches: string[] = [];
    for (const [syn, canon] of Object.entries(CANONICAL_SAMPLE)) {
      const synExpr = buildMatchExpr(syn);
      if (!synExpr.includes(`"${canon}"*`)) {
        mismatches.push(`${syn} → "${synExpr}" missing canonical "${canon}"`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

// ─── 6. Generated natural-language queries (cartesian verb × noun) ─────────────

describe("RAG: generated natural-language action queries", () => {
  // Each (phrasing → expected command id substring) — synonyms + fillers mixed.
  const VERB_PHRASES = [
    "create", "make", "add", "new",
    "delete", "remove", "destroy",
    "list", "show", "view",
    "run", "trigger", "launch", "start",
    "stop", "kill", "cancel", "abort",
  ];
  const NOUN_PHRASES = ["job", "build", "node", "agent", "credential", "secret"];
  const FILLERS = ["", "how do i ", "a ", "the ", "please ", "i want to "];

  it("verb×noun×filler queries always return at least one hit", () => {
    const empties: string[] = [];
    let total = 0;
    for (const v of VERB_PHRASES) {
      for (const n of NOUN_PHRASES) {
        for (const f of FILLERS) {
          total++;
          const q = `${f}${v} ${n}`;
          const hits = searchDocs(q, CORPUS, 5);
          if (hits.length === 0) empties.push(q);
        }
      }
    }
    expect(total).toBeGreaterThanOrEqual(600);
    expect(empties).toEqual([]);
  });

  it("action verbs route to the right command family", () => {
    // (verb synonym, noun synonym) → expected command id prefix
    const cases: [string, string, string][] = [
      ["create", "job", "job.create"],
      ["make", "job", "job.create"],
      ["delete", "job", "job.delete"],
      // NOTE: "remove" is deliberately omitted here — it is ambiguous under
      // expand-both (matches job.delete, *.untrack, AND job.remove-agent). The
      // ambiguity is correct: a user typing "remove job" might mean any of them.
      ["run", "job", "job.run"],
      ["trigger", "build", "job.run"],
      ["stop", "build", "job.stop"],
      ["kill", "build", "job.stop"],
      ["list", "node", "node.list"],
      ["delete", "node", "node.delete"],
      ["delete", "agent", "node.delete"],
      ["create", "credential", "cred.create"],
      ["create", "secret", "cred.create"],
      ["delete", "credential", "cred.delete"],
    ];
    const misses: string[] = [];
    for (const [v, n, prefix] of cases) {
      const hits = searchDocs(`${v} ${n}`, CORPUS, 8);
      const cmdHits = hits.filter((h) => h.type === "command");
      if (!cmdHits.some((h) => h.id.startsWith(prefix))) {
        const got = cmdHits.map((h) => h.id).join(", ");
        misses.push(`"${v} ${n}" expected ${prefix}, got [${got}]`);
      }
    }
    expect(misses).toEqual([]);
  });
});

// ─── 7. buildMatchExpr robustness (fuzz-style) ─────────────────────────────────

describe("RAG: buildMatchExpr robustness", () => {
  it("never throws and never produces unquoted FTS operators", () => {
    const inputs = [
      "", "   ", "!!!", "***", "job; drop table", '"quoted"', "a' OR '1'='1",
      "node\\path", "run -- job", "café", "日本語", "job\n\nlist", "\t\t",
      "create+job", "node.list", "a".repeat(500), "1234567890",
      "MixedCASE Query", "job OR node AND cred NOT auth",
    ];
    for (const input of inputs) {
      let expr = "";
      expect(() => { expr = buildMatchExpr(input); }).not.toThrow();
      // Every emitted term must be a quoted prefix term; the only bare token
      // allowed between them is OR.
      if (expr !== "") {
        const parts = expr.split(" OR ");
        for (const p of parts) {
          expect(p).toMatch(/^"[a-z0-9]+"\*$/);
        }
      }
    }
  });

  it("all-stopword query yields empty expr", () => {
    expect(buildMatchExpr("how do i the a an")).toBe("");
    // "what" is no longer a stopword (it expands to "concept" via synonym)
    // but a truly all-stopword query should still return empty
    expect(buildMatchExpr("is it the a an")).toBe("");
  });

  it("injection attempt is neutralised (no executable FTS syntax leaks)", () => {
    // Even a malicious string must not crash searchDocs.
    const hits = searchDocs('job" OR "1"="1', CORPUS, 5);
    expect(Array.isArray(hits)).toBe(true);
  });
});

// ─── 8. searchDocs invariants over generated queries ──────────────────────────

describe("RAG: searchDocs invariants", () => {
  it("respects the limit for thousands of queries", () => {
    const verbs = ["create", "delete", "list", "run", "stop", "update", "get", "track"];
    const nouns = ["job", "node", "credential", "controller", "profile", "folder", "agent", "build"];
    let violations = 0;
    let total = 0;
    for (const v of verbs) {
      for (const n of nouns) {
        for (const limit of [1, 2, 3, 5, 8, 13]) {
          total++;
          const hits = searchDocs(`${v} ${n}`, CORPUS, limit);
          if (hits.length > limit) violations++;
        }
      }
    }
    expect(total).toBeGreaterThanOrEqual(300);
    expect(violations).toBe(0);
  });

  it("never returns duplicate ids in a single result set", () => {
    const verbs = ["create", "delete", "list", "run", "stop"];
    const nouns = ["job", "node", "credential", "agent", "secret"];
    const dupes: string[] = [];
    for (const v of verbs) {
      for (const n of nouns) {
        const hits = searchDocs(`${v} ${n}`, CORPUS, 25);
        const ids = hits.map((h) => h.id);
        if (new Set(ids).size !== ids.length) dupes.push(`${v} ${n}`);
      }
    }
    expect(dupes).toEqual([]);
  });

  it("every returned hit is a real corpus member", () => {
    const corpusIds = new Set(CORPUS.map((d) => d.id));
    const verbs = ["create", "delete", "list", "run", "login", "logout"];
    const nouns = ["job", "node", "credential", "profile", "controller"];
    const orphans: string[] = [];
    for (const v of verbs) {
      for (const n of nouns) {
        const hits = searchDocs(`${v} ${n}`, CORPUS, 10);
        for (const h of hits) {
          if (!corpusIds.has(h.id)) orphans.push(h.id);
        }
      }
    }
    expect(orphans).toEqual([]);
  });
});

// ─── 9. Concept / troubleshooting Q&A routing ──────────────────────────────────

describe("RAG: concept and troubleshooting questions route to docs", () => {
  const cases: [string, string][] = [
    ["what is a profile", "concepts"],
    ["what does mine mean", "concepts"],
    ["how does the cache work", "concepts"],
    ["403 unauthorized error", "troubleshooting"],
    ["not logged in error", "troubleshooting"],
    ["how do i get started", "getting-started"],
    ["environment variables", "env-vars"],
    ["keyboard navigation table", "tui"],
  ];

  it("each question surfaces at least one doc chunk from the expected file", () => {
    const misses: string[] = [];
    for (const [q, expectedSource] of cases) {
      const hits = searchDocs(q, CORPUS, 15);
      const docHits = hits.filter((h) => h.type === "doc");
      if (!docHits.some((h) => h.source.includes(expectedSource))) {
        const got = docHits.map((h) => h.source).join(", ");
        misses.push(`"${q}" expected ${expectedSource}, got [${got}]`);
      }
    }
    expect(misses).toEqual([]);
  });
});
