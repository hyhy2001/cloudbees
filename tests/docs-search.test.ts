import { Command } from "commander";
import { buildCorpus, searchDocs, buildMatchExpr, expandToken } from "../src/plugins/docs/corpus";
import { chunkMarkdown, buildDocChunks } from "../src/plugins/docs/docs-index";
import { describe, it, expect } from "bun:test";

// ─── minimal commander program ───────────────────────────────────────────────

function buildTestProgram(): Command {
  const prog = new Command("bee");

  const job = prog.command("job").description("Manage CloudBees jobs");
  job.command("list").description("List all jobs").option("--all", "Show all jobs");
  job.command("create").description("Create a new job");

  const auth = prog.command("auth").description("Authentication and profiles");
  auth.command("login").description("Login to a CloudBees server").argument("<url>", "Server URL");
  auth.command("logout").description("Log out from the active profile");

  prog.command("ask").description("Ask how to use bee");

  return prog;
}

// ─── buildCorpus ─────────────────────────────────────────────────────────────

describe("buildCorpus", () => {
  it("contains command items for registered commands", () => {
    const corpus = buildCorpus(buildTestProgram(), { includeDocChunks: true });
    const cmds = corpus.filter((d) => d.type === "command");
    const ids = cmds.map((d) => d.id);
    expect(ids).toContain("job");
    expect(ids).toContain("job.list");
    expect(ids).toContain("auth.login");
  });

  it("command items include flags in body", () => {
    const corpus = buildCorpus(buildTestProgram(), { includeDocChunks: true });
    const listItem = corpus.find((d) => d.id === "job.list");
    expect(listItem?.body).toContain("--all");
  });

  it("command title includes argument sigils", () => {
    const corpus = buildCorpus(buildTestProgram(), { includeDocChunks: true });
    const loginItem = corpus.find((d) => d.id === "auth.login");
    expect(loginItem?.title).toBe("bee auth login <url>");
  });

  it("command source is 'command'", () => {
    const corpus = buildCorpus(buildTestProgram(), { includeDocChunks: true });
    const item = corpus.find((d) => d.id === "job.list");
    expect(item?.source).toBe("command");
  });

  it("contains doc items from embedded docs", () => {
    const corpus = buildCorpus(buildTestProgram(), { includeDocChunks: true });
    const docs = corpus.filter((d) => d.type === "doc");
    expect(docs.length).toBeGreaterThan(0);
  });

  it("doc items carry a source file label", () => {
    const corpus = buildCorpus(buildTestProgram(), { includeDocChunks: true });
    const docs = corpus.filter((d) => d.type === "doc");
    const sources = new Set(docs.map((d) => d.source));
    expect(sources.has("concepts.md")).toBe(true);
    expect(sources.has("cli/job.md")).toBe(true);
  });
});

// ─── chunkMarkdown ────────────────────────────────────────────────────────────

describe("chunkMarkdown", () => {
  const sample = [
    "# Getting Started",
    "Intro text here.",
    "",
    "## Install",
    "Run the binary.",
    "",
    "## Login",
    "Use bee auth login.",
    "```bash",
    "# this comment is not a heading",
    "bee auth login",
    "```",
  ].join("\n");

  it("splits at ## headings", () => {
    const chunks = chunkMarkdown("test.md", sample);
    const headings = chunks.map((c) => c.heading);
    expect(headings).toContain("Getting Started");
    expect(headings).toContain("Install");
    expect(headings).toContain("Login");
  });

  it("body contains section text", () => {
    const chunks = chunkMarkdown("test.md", sample);
    const install = chunks.find((c) => c.heading === "Install");
    expect(install?.body).toContain("Run the binary.");
  });

  it("does NOT split on # inside a fenced code block", () => {
    const chunks = chunkMarkdown("test.md", sample);
    const login = chunks.find((c) => c.heading === "Login");
    // The "# this comment is not a heading" should be in Login's body, not a new chunk
    expect(login?.body).toContain("# this comment is not a heading");
    const headings = chunks.map((c) => c.heading);
    expect(headings).not.toContain("this comment is not a heading");
  });

  it("id is source#slug", () => {
    const chunks = chunkMarkdown("concepts.md", sample);
    const install = chunks.find((c) => c.heading === "Install");
    expect(install?.id).toBe("concepts.md#install");
  });

  it("handles file with no headings", () => {
    const chunks = chunkMarkdown("plain.md", "just some text\nno headings");
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.body).toContain("just some text");
  });
});

// ─── buildDocChunks ───────────────────────────────────────────────────────────

describe("buildDocChunks", () => {
  it("returns chunks from all embedded files", () => {
    const chunks = buildDocChunks();
    const sources = new Set(chunks.map((c) => c.source));
    expect(sources.has("getting-started.md")).toBe(true);
    expect(sources.has("concepts.md")).toBe(true);
    expect(sources.has("troubleshooting.md")).toBe(true);
    expect(sources.has("cli/job.md")).toBe(true);
    expect(sources.has("cli/node.md")).toBe(true);
    expect(sources.has("tui.md")).toBe(true);
  });

  it("chunks have non-empty body", () => {
    const chunks = buildDocChunks();
    const withBody = chunks.filter((c) => c.body.trim().length > 0);
    expect(withBody.length).toBeGreaterThan(10);
  });
});

// ─── buildMatchExpr ───────────────────────────────────────────────────────────

describe("buildMatchExpr", () => {
  it("converts simple query to prefix OR terms", () => {
    expect(buildMatchExpr("list job")).toBe('"list"* OR "job"*');
  });

  it("lowercases tokens", () => {
    expect(buildMatchExpr("Create Job")).toBe('"create"* OR "job"*');
  });

  it("strips non-alphanumeric delimiters", () => {
    expect(buildMatchExpr("create-job!")).toBe('"create"* OR "job"*');
  });

  it("returns empty for blank or symbol-only input", () => {
    expect(buildMatchExpr("")).toBe("");
    expect(buildMatchExpr("!!!")).toBe("");
  });

  it("single token produces single prefix term", () => {
    expect(buildMatchExpr("login")).toBe('"login"*');
  });

  it("drops stopwords from a natural-language query", () => {
    // "how", "do", "i", "a" are stopwords → only "run" and "build" survive.
    // "build" keeps its original token AND adds its synonym "job".
    expect(buildMatchExpr("how do I run a build")).toBe('"run"* OR "build"* OR "job"*');
  });

  it("returns empty when query is all stopwords", () => {
    expect(buildMatchExpr("how do I")).toBe("");
  });

  it("expands synonyms while keeping the original token", () => {
    // Synonyms are additive (OR), not replacements: the original token is kept
    // so exact matches (e.g. a literal command name) still rank, while the
    // canonical synonym broadens recall.
    expect(buildMatchExpr("kill")).toBe('"kill"* OR "stop"*');
    expect(buildMatchExpr("remove")).toBe('"remove"* OR "delete"*');
    expect(buildMatchExpr("agent")).toBe('"agent"* OR "node"*');
    expect(buildMatchExpr("secret")).toBe('"secret"* OR "credential"*');
  });

  it("deduplicates the shared synonym target", () => {
    // "cancel" → stop, "abort" → stop: both originals kept, target "stop" once.
    expect(buildMatchExpr("cancel abort")).toBe('"cancel"* OR "stop"* OR "abort"*');
  });

  it("preserves first-seen order and dedups the shared target", () => {
    // "agent" → node, "machine" → node: target "node" appears once.
    expect(buildMatchExpr("create agent machine")).toBe(
      '"create"* OR "agent"* OR "node"* OR "machine"*',
    );
  });
});

describe("expandToken", () => {
  it("maps a known synonym to its canonical term", () => {
    expect(expandToken("kill")).toBe("stop");
    expect(expandToken("slave")).toBe("node");
  });

  it("returns the token unchanged when no synonym exists", () => {
    expect(expandToken("job")).toBe("job");
    expect(expandToken("xyzzy")).toBe("xyzzy");
  });
});

// ─── searchDocs (hybrid FTS5/BM25) ───────────────────────────────────────────

describe("searchDocs — command queries", () => {
  const corpus = buildCorpus(buildTestProgram(), { includeDocChunks: true });

  it("finds job.list for query 'list job'", () => {
    const hits = searchDocs("list job", corpus, 10);
    expect(hits.some((h) => h.id === "job.list")).toBe(true);
  });

  it("finds auth.login for query 'login'", () => {
    const hits = searchDocs("login", corpus, 10);
    expect(hits.some((h) => h.id === "auth.login")).toBe(true);
  });

  it("returns empty for nonsense query (pure random hash)", () => {
    // Must be a string with no real English tokens to avoid matching docs prose.
    const hits = searchDocs("zqxw7f2k9vb", corpus, 5);
    expect(hits.length).toBe(0);
  });

  it("respects limit", () => {
    const hits = searchDocs("job", corpus, 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it("returns empty for blank query", () => {
    expect(searchDocs("", corpus, 5)).toHaveLength(0);
  });

  it("returns empty for empty corpus", () => {
    expect(searchDocs("login", [], 5)).toHaveLength(0);
  });
});

describe("searchDocs — doc queries", () => {
  const corpus = buildCorpus(buildTestProgram(), { includeDocChunks: true });

  it("finds concepts.md chunk for 'what is a profile'", () => {
    const hits = searchDocs("what is a profile", corpus, 10);
    const docHits = hits.filter((h) => h.type === "doc");
    expect(docHits.length).toBeGreaterThan(0);
    const sources = docHits.map((h) => h.source);
    expect(sources.some((s) => s.includes("concepts"))).toBe(true);
  });

  it("finds troubleshooting chunk for '403 error'", () => {
    const hits = searchDocs("403 error", corpus, 10);
    const docHits = hits.filter((h) => h.type === "doc");
    expect(docHits.some((h) => h.source === "troubleshooting.md")).toBe(true);
  });

  it("finds tui.md chunk for 'global keys tab'", () => {
    const hits = searchDocs("global keys tab", corpus, 10);
    const docHits = hits.filter((h) => h.type === "doc");
    expect(docHits.some((h) => h.source === "tui.md")).toBe(true);
  });

  it("prefix match: 'cred' surfaces credential content", () => {
    const hits = searchDocs("cred", corpus, 10);
    const credHits = hits.filter((h) =>
      h.id.includes("cred") || (h.type === "doc" && h.source.includes("cred"))
    );
    expect(credHits.length).toBeGreaterThan(0);
  });
});

// ─── searchDocs — synonym expansion ──────────────────────────────────────────

describe("searchDocs — synonym expansion", () => {
  const corpus = buildCorpus(buildTestProgram(), { includeDocChunks: true });

  it("'remove a job' (remove→delete) reaches a delete-related result", () => {
    // Test program has no delete cmd, but docs mention deleting jobs.
    const hits = searchDocs("remove a job", corpus, 10);
    const blob = hits.map((h) => `${h.title} ${h.body}`).join(" ").toLowerCase();
    expect(blob).toContain("delete");
  });

  it("'kill a build' (kill→stop, build→job) surfaces stop/job content", () => {
    const hits = searchDocs("kill a build", corpus, 10);
    const blob = hits.map((h) => `${h.title} ${h.body}`).join(" ").toLowerCase();
    expect(blob).toMatch(/stop|job/);
  });

  it("'agent' (agent→node) surfaces node content", () => {
    const hits = searchDocs("agent", corpus, 10);
    const blob = hits.map((h) => `${h.title} ${h.body} ${h.source}`).join(" ").toLowerCase();
    expect(blob).toContain("node");
  });

  it("'signin' (signin→login) surfaces login content", () => {
    const hits = searchDocs("signin", corpus, 10);
    expect(hits.some((h) => h.id === "auth.login" || /login/i.test(h.body) || /login/i.test(h.title))).toBe(true);
  });
});
