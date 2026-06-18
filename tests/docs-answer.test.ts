import { describe, it, expect, beforeEach } from "bun:test";
import { answer, setProvider, getProvider, type LMProvider } from "../src/plugins/docs/answer";
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
  it("renders title in header line", () => {
    const out = formatDocItem(JOB_RUN);
    expect(out.split("\n")[0]).toContain("bee job run <name>");
  });

  it("includes description", () => {
    const out = formatDocItem(JOB_RUN);
    expect(out).toContain("Trigger a job build");
  });

  it("includes flags from body", () => {
    const out = formatDocItem(JOB_RUN);
    expect(out).toContain("--wait");
  });

  it("handles item with empty body", () => {
    const noBody: DocItem = { ...JOB_RUN, body: "" };
    const out = formatDocItem(noBody);
    expect(out).not.toContain("--");
  });

  it("handles item with no description", () => {
    const noDesc: DocItem = { ...JOB_RUN, description: "" };
    const out = formatDocItem(noDesc);
    expect(out.split("\n")[0]).toContain("bee job run <name>");
    expect(out).toContain("--wait");
  });
});

describe("formatDocItem — doc type", () => {
  it("renders source + heading label", () => {
    const out = formatDocItem(CONCEPTS_PROFILE);
    expect(out).toContain("concepts.md");
    expect(out).toContain("Profiles");
  });

  it("includes body prose", () => {
    const out = formatDocItem(CONCEPTS_PROFILE);
    expect(out).toContain("saved identity");
  });
});

describe("formatContext", () => {
  it("joins multiple items with blank line", () => {
    const out = formatContext([JOB_RUN, CONCEPTS_PROFILE]);
    expect(out).toContain("bee job run <name>");
    expect(out).toContain("Profiles");
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
    expect(p).toContain("bee job run <name>");
    expect(p).toContain("--wait");
  });

  it("ends with answer instruction", () => {
    const p = buildPrompt("test", [JOB_RUN]);
    expect(p.trimEnd()).toMatch(/Answer:\s*$/);
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
