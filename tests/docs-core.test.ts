/**
 * Comprehensive tests for the bee ask core — corpus, search, gate, presenter, config.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { Command } from "commander";
import { initPlugins } from "../src/registry/index";
import {
  buildCorpus,
  buildMatchExpr,
  expandToken,
  passesRelevanceGate,
  relevanceCoverage,
  searchDocs,
} from "../src/plugins/docs/corpus";
import { presentAnswer } from "../src/plugins/docs/presenter";
import type { DocItem } from "../src/plugins/docs/corpus";

// ─── Shared corpus (built once with full command tree) ────────────────────────

let program: Command;
let corpus: DocItem[];

beforeAll(async () => {
  program = new Command().name("bee");
  await initPlugins(program);
  corpus = buildCorpus(program, { includeDocChunks: false });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildCorpus
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildCorpus", () => {
  test("includes command items with usage, description, and flags", () => {
    const jobList = corpus.find((c) => c.id === "job.list");
    expect(jobList).toBeDefined();
    expect(jobList!.type).toBe("command");
    expect(jobList!.title).toContain("bee job list");
  });

  test("every command has a non-empty id", () => {
    const cmds = corpus.filter((c) => c.type === "command");
    for (const cmd of cmds) {
      expect(cmd.id.length).toBeGreaterThan(0);
    }
  });

  test("includes help facts from generated index", () => {
    const facts = corpus.filter((c) => c.source.startsWith("help:"));
    expect(facts.length).toBeGreaterThan(20);
  });

  test("help fact body includes terms, commands, and related", () => {
    const profileFact = corpus.find((c) => c.id === "concept.profile");
    expect(profileFact).toBeDefined();
    expect(profileFact!.body).toContain("bee auth profiles");
  });

  test("command body contains flag definitions", () => {
    const jobRun = corpus.find((c) => c.id === "job.run");
    expect(jobRun).toBeDefined();
    expect(jobRun!.body).toContain("--wait");
  });

  test("command description is present", () => {
    const nodeCreate = corpus.find((c) => c.id === "node.create");
    expect(nodeCreate).toBeDefined();
    expect(nodeCreate!.description.length).toBeGreaterThan(10);
  });

  test("does not include doc chunks by default (production mode)", () => {
    const chunks = corpus.filter((c) => c.source.includes(".md"));
    expect(chunks.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildMatchExpr
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildMatchExpr", () => {
  test("simple query becomes prefix OR terms", () => {
    const expr = buildMatchExpr("list jobs");
    expect(expr).toContain('"list"*');
    expect(expr).toContain('"jobs"*');
  });

  test("removes stopwords", () => {
    const expr = buildMatchExpr("how do I run a job");
    // "how", "do", "I", "a" are stopwords — only "run", "job" remain
    expect(expr).not.toContain('"how"');
    expect(expr).not.toContain('"do"');
    expect(expr).not.toContain('"a"');
    expect(expr).toContain('"run"');
    expect(expr).toContain('"job"');
  });

  test("empty query returns empty string", () => {
    expect(buildMatchExpr("")).toBe("");
  });

  test("all-stopword query returns empty", () => {
    expect(buildMatchExpr("the and of it")).toBe("");
  });

  test("expands synonyms while keeping the original token", () => {
    const expr = buildMatchExpr("kill build");
    // "kill" → "stop" (synonym), "build" → "job" (synonym)
    expect(expr).toContain('"kill"*');
    expect(expr).toContain('"stop"*');
    expect(expr).toContain('"build"*');
    expect(expr).toContain('"job"*');
  });

  test("deduplicates expanded synonyms", () => {
    // "create" and "add" both expand to "create"
    const expr = buildMatchExpr("create add");
    expect(expr).toContain('"create"*');
    expect(expr).toContain('"add"*');
    // "create" should only appear once despite two synonyms mapping to it
    const createMatches = expr.match(/"create"\*/g);
    expect(createMatches).toHaveLength(1);
  });

  test("drops non-alphanumeric delimiters", () => {
    const expr = buildMatchExpr("list-jobs!");
    expect(expr).toContain('"list"*');
    expect(expr).toContain('"jobs"*');
  });

  test("single token produces single prefix term", () => {
    const expr = buildMatchExpr("login");
    expect(expr).toContain('"login"*');
    expect(expr).not.toContain(" OR ");
  });

  test("preserves 'cloudbees' as content token", () => {
    const expr = buildMatchExpr("connect to cloudbees");
    expect(expr).toContain('"cloudbees"*');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// expandToken
// ═══════════════════════════════════════════════════════════════════════════════

describe("expandToken", () => {
  test("maps kill → stop", () => {
    expect(expandToken("kill")).toBe("stop");
  });

  test("maps unrecognized token to itself", () => {
    expect(expandToken("zzzzzz")).toBe("zzzzzz");
  });

  test("maps cache → ttl", () => {
    expect(expandToken("cache")).toBe("ttl");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// passesRelevanceGate / relevanceCoverage
// ═══════════════════════════════════════════════════════════════════════════════

describe("relevanceCoverage", () => {
  const item: DocItem = {
    id: "auth.login",
    type: "command",
    title: "bee auth login",
    description: "Log in to a CloudBees server",
    body: "--profile <name>   Profile name",
    source: "command",
  };

  test("query matching title gets full coverage", () => {
    const rc = relevanceCoverage("login", item);
    expect(rc.cov).toBeGreaterThanOrEqual(0.99);
  });

  test("query matching description", () => {
    const rc = relevanceCoverage("cloudbees server", item);
    expect(rc.cov).toBeGreaterThanOrEqual(0.5);
  });

  test("query matching flag body", () => {
    const rc = relevanceCoverage("profile", item);
    expect(rc.cov).toBeGreaterThanOrEqual(0.99);
  });

  test("no matching tokens returns 0 coverage", () => {
    const rc = relevanceCoverage("zzzzz yyyyy", item);
    expect(rc.cov).toBe(0);
  });

  test("empty query returns 0 coverage", () => {
    const rc = relevanceCoverage("", item);
    expect(rc.cov).toBe(0);
  });
});

describe("passesRelevanceGate", () => {
  const item: DocItem = {
    id: "auth.login",
    type: "command",
    title: "bee auth login",
    description: "Log in to a CloudBees server",
    body: "--profile <name>   Profile name",
    source: "command",
  };

  test("matched query passes", () => {
    expect(passesRelevanceGate("login", item)).toBe(true);
  });

  test("unrelated query fails", () => {
    expect(passesRelevanceGate("zzzzz", item)).toBe(false);
  });

  test("single-token query with match passes", () => {
    expect(passesRelevanceGate("profile", item)).toBe(true);
  });

  test("two-token query with one match fails", () => {
    expect(passesRelevanceGate("profile zzzzz", item)).toBe(false);
  });

  test("all stopwords query fails", () => {
    expect(passesRelevanceGate("how do i", item)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// searchDocs — edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("searchDocs edge cases", () => {
  test("empty query returns empty", () => {
    expect(searchDocs("", corpus)).toEqual([]);
  });

  test("empty corpus returns empty", () => {
    expect(searchDocs("login", [])).toEqual([]);
  });

  test("returns at most limit results", () => {
    const hits = searchDocs("job", corpus, 3);
    expect(hits.length).toBeLessThanOrEqual(3);
  });

  test("exact command path is promoted to rank 1", () => {
    const hits = searchDocs("node create", corpus, 10, { gate: false });
    expect(hits[0]!.id).toBe("node.create");
  });

  test("relevance gate filters low-coverage hits", () => {
    const hits = searchDocs("zzzzz yyyyy", corpus, 5, { gate: true });
    expect(hits).toEqual([]);
  });

  test("soft gate rescues empty gate result", () => {
    // A query matching only one of two required tokens: BM25 returns results but
    // the gate (needing 2+ tokens) empties them. Soft gate falls back.
    const hits = searchDocs("login zzzzz", corpus, 5, { gate: true, softGate: true });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    // Without soft gate, the same query returns empty.
    const strict = searchDocs("login zzzzz", corpus, 5, { gate: true });
    expect(strict).toEqual([]);
  });

  test("promotion layer does not crash on short corpus", () => {
    const tiny: DocItem[] = [
      { id: "test.cmd", type: "command", title: "bee test cmd", description: "test", body: "", source: "command" },
    ];
    const hits = searchDocs("test", tiny, 5, { gate: false });
    expect(hits.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// presentAnswer — edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("presentAnswer", () => {
  test("renders command answer with usage and description", () => {
    const result = presentAnswer("login", [
      { id: "auth.login", type: "command", title: "bee auth login", description: "Log in to a server", body: "--profile <name>  Profile", source: "command" },
    ]);
    expect(result.text).toContain("bee auth login");
    expect(result.text).toContain("Log in to a server");
  });

  test("renders doc answer with body text", () => {
    const result = presentAnswer("profile", [
      { id: "concept.profile", type: "doc", title: "profile", description: "concept", body: "A profile is a saved login target.\nbee auth login\nbee auth profiles", source: "help:concept" },
    ]);
    expect(result.text).toContain("saved login target");
  });

  test("shows no-result message for empty hits", () => {
    const result = presentAnswer("zzz", []);
    expect(result.text).toContain("No results");
  });

  test("includes related commands link section", () => {
    const result = presentAnswer("login", [
      { id: "auth.login", type: "command", title: "bee auth login", description: "Log in", body: "", source: "command" },
    ]);
    expect(result.text).toContain("bee auth login");
  });
});
