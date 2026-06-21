import { describe, it, expect, beforeEach } from "bun:test";
import { answer, setProvider, getProvider, stripInventedCommands, type LMProvider } from "../src/plugins/docs/answer";
import { formatDocItem, formatContext, buildPrompt, SYSTEM_PROMPT } from "../src/plugins/docs/context";
import type { DocItem } from "../src/plugins/docs/corpus";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const JOB_RUN: DocItem = {
  id: "job.run",
  type: "command",
  title: "bee job run <name>",
  description: "Trigger a job build",
  body: "--wait                      Wait for build to finish\n--timeout <seconds>         Max wait time in seconds",
  source: "command",
};

const CONCEPTS_PROFILE: DocItem = {
  id: "concepts.md#profiles",
  type: "doc",
  title: "Profiles",
  description: "concepts.md",
  body: "A profile is a saved identity: one server URL + username + encrypted token.",
  source: "concepts.md",
};

// Reset provider between tests
beforeEach(() => {
  setProvider(null as unknown as LMProvider);
});

// ─── context.ts ─────────────────────────────────────────────────────────────

describe("formatDocItem — command type", () => {
  it("renders XML command tag with escaped id", () => {
    const out = formatDocItem(JOB_RUN);
    expect(out).toContain('<command id="bee job run &lt;name&gt;">');
  });

  it("includes description in <desc> tag", () => {
    const out = formatDocItem(JOB_RUN);
    expect(out).toContain("<desc>");
    expect(out).toContain("Trigger a job build");
  });

  it("includes flags as <flag> elements", () => {
    const out = formatDocItem(JOB_RUN);
    expect(out).toContain("<flag>--wait</flag>");
    expect(out).toContain("<flag>--timeout</flag>");
  });

  it("handles item with empty body", () => {
    const noBody: DocItem = { ...JOB_RUN, body: "" };
    const out = formatDocItem(noBody);
    expect(out).not.toContain("<flag>");
  });

  it("handles item with no description", () => {
    const noDesc: DocItem = { ...JOB_RUN, description: "" };
    const out = formatDocItem(noDesc);
    expect(out).toContain('<command id="bee job run &lt;name&gt;">');
    expect(out).toContain("<flag>--wait</flag>");
  });
});

describe("formatDocItem — doc type", () => {
  it("renders info tag with escaped id", () => {
    const out = formatDocItem(CONCEPTS_PROFILE);
    expect(out).toContain("<info id=");
    expect(out).toContain("concepts.md");
  });

  it("includes body prose", () => {
    const out = formatDocItem(CONCEPTS_PROFILE);
    expect(out).toContain("saved identity");
  });
});

describe("formatContext", () => {
  it("joins multiple items with blank line", () => {
    const out = formatContext([JOB_RUN, CONCEPTS_PROFILE]);
    expect(out).toContain("<command id");
    expect(out).toContain("<info id");
    expect(out).toContain("\n\n");
  });

  it("returns empty string for empty hits", () => {
    expect(formatContext([])).toBe("");
  });
});

describe("buildPrompt", () => {
  it("contains the system prompt", () => {
    const p = buildPrompt("how to run a job", [JOB_RUN]);
    expect(p).toContain(SYSTEM_PROMPT);
  });

  it("contains the query", () => {
    const p = buildPrompt("how to run a job", [JOB_RUN]);
    expect(p).toContain("how to run a job");
  });

  it("contains formatted context", () => {
    const p = buildPrompt("how to run a job", [JOB_RUN]);
    expect(p).toContain("<command id=\"bee job run &lt;name&gt;\">");
    expect(p).toContain("<flag>--wait</flag>");
  });

  it("ends with Answer:", () => {
    const p = buildPrompt("test", [JOB_RUN]);
    expect(p.trimEnd()).toMatch(/Answer:\s*$/);
  });

  it("example format uses a real command, not a fake placeholder", () => {
    const p = buildPrompt("test", [JOB_RUN]);
    expect(p).not.toContain("bee X Y");
  });
});

// ─── answer.ts ───────────────────────────────────────────────────────────────

describe("setProvider / getProvider", () => {
  it("starts null (reset by beforeEach)", () => {
    expect(getProvider()).toBeNull();
  });

  it("stores and retrieves a provider", () => {
    const p: LMProvider = { name: "test", generate: async () => "hi" };
    setProvider(p);
    expect(getProvider()).toBe(p);
  });
});

describe("answer() — no provider", () => {
  it("returns source=raw with hits intact", async () => {
    const result = await answer("run a job", [JOB_RUN]);
    expect(result.source).toBe("raw");
    expect(result.text).toBe("");
    expect(result.hits).toEqual([JOB_RUN]);
    expect(result.provider).toBeUndefined();
  });

  it("returns source=raw when hits is empty", async () => {
    const result = await answer("run a job", []);
    expect(result.source).toBe("raw");
    expect(result.hits).toEqual([]);
  });
});

describe("answer() — with provider", () => {
  it("calls provider.generate and returns lm response", async () => {
    const p: LMProvider = {
      name: "mock",
      generate: async (prompt) => {
        expect(prompt).toContain("run a job");
        expect(prompt).toContain("bee job run");
        expect(prompt).toContain("<context>");
        return "Use `bee job run <name>`.";
      },
    };
    setProvider(p);
    const result = await answer("run a job", [JOB_RUN]);
    expect(result.source).toBe("lm");
    expect(result.text).toBe("Use `bee job run <name>`.");
    expect(result.provider).toBe("mock");
    expect(result.hits).toEqual([JOB_RUN]);
  });

  it("degrades to raw on provider error", async () => {
    const p: LMProvider = {
      name: "broken",
      generate: async () => { throw new Error("connection refused"); },
    };
    setProvider(p);
    const result = await answer("run a job", [JOB_RUN]);
    expect(result.source).toBe("raw");
    expect(result.text).toBe("");
    expect(result.hits).toEqual([JOB_RUN]);
  });

  it("returns raw when hits empty even with provider set", async () => {
    const p: LMProvider = { name: "mock", generate: async () => "should not be called" };
    setProvider(p);
    const result = await answer("run a job", []);
    expect(result.source).toBe("raw");
  });
});

// ─── stripInventedCommands ────────────────────────────────────────────────────

describe("stripInventedCommands", () => {
  // Corpus of real command ids. NODE_CREATE/AUTH_LOGIN added so multi-group
  // answers have something valid to keep.
  const NODE_CREATE: DocItem = { id: "node.create", type: "command", title: "bee node create <name>", description: "", body: "", source: "command" };
  const AUTH_LOGIN: DocItem = { id: "auth.login", type: "command", title: "bee auth login", description: "", body: "", source: "command" };
  const corpus = [JOB_RUN, NODE_CREATE, AUTH_LOGIN];

  it("keeps real sub-commands untouched", () => {
    const t = "Trigger a build. Use: `bee job run <name>`";
    expect(stripInventedCommands(t, corpus)).toBe(t);
  });

  it("keeps a bare valid group name", () => {
    // JOB_RUN's group "job" is valid via job.run → "bee job" should survive.
    const t = "Manage jobs with `bee job`.";
    expect(stripInventedCommands(t, corpus)).toBe(t);
  });

  it("strips a fake sub-command", () => {
    const out = stripInventedCommands("Start it with `bee job start <name>`.", corpus);
    expect(out).not.toContain("bee job start");
  });

  it("strips a fake top-level command", () => {
    const out = stripInventedCommands("List all with `bee list --all`.", corpus);
    expect(out).not.toContain("bee list");
  });

  it("removes only the fake command from a mixed list, keeping real ones", () => {
    const out = stripInventedCommands(
      "Use: `bee job run <name>`, `bee job start`, `bee node create <name>`",
      corpus,
    );
    expect(out).toContain("bee job run");
    expect(out).toContain("bee node create");
    expect(out).not.toContain("bee job start");
    expect(out).not.toMatch(/,\s*,/); // no comma debris left behind
  });

  it("never touches non-command backtick spans (flags, prose)", () => {
    const t = "Pass `--wait` to block until done.";
    expect(stripInventedCommands(t, corpus)).toBe(t);
  });

  it("leaves bee ask / bee help alone (not real corpus commands but valid)", () => {
    const t = "See `bee --help` or `bee ask`.";
    expect(stripInventedCommands(t, corpus)).toBe(t);
  });

  it("strips fake commands even when corpus has no commands (always keeps ask/help)", () => {
    const t = "Use `bee whatever made up`.";
    const result = stripInventedCommands(t, [CONCEPTS_PROFILE]);
    // The fake command `bee whatever made up` is stripped
    expect(result).not.toContain("bee whatever");
  });
});

describe("answer() — strips invented commands from lm output", () => {
  it("removes a fake backtick command", async () => {
    const p: LMProvider = {
      name: "mock",
      generate: async () => "Run it. Use: `bee job run <name>`, `bee job start <name>`",
    };
    setProvider(p);
    const result = await answer("run a job", [JOB_RUN]);
    expect(result.source).toBe("lm");
    expect(result.text).toContain("bee job run");
    expect(result.text).not.toContain("bee job start");
  });
});
