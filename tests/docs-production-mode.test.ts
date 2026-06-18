import { describe, it, expect } from "bun:test";
import { Command } from "commander";
import { buildCorpus, searchDocs } from "../src/plugins/docs/corpus";
import { presentAnswer } from "../src/plugins/docs/presenter";

describe("docs production mode", () => {
  it("buildCorpus excludes embedded doc chunks by default", () => {
    const program = new Command("bee");
    const corpus = buildCorpus(program);
    expect(corpus.some((d) => d.source === "concepts.md")).toBe(false);
    expect(corpus.some((d) => d.source.startsWith("help:"))).toBe(true);
  });

  it("buildCorpus can include embedded doc chunks explicitly", () => {
    const program = new Command("bee");
    const corpus = buildCorpus(program, { includeDocChunks: true });
    expect(corpus.some((d) => d.source === "concepts.md")).toBe(true);
  });

  it("presenter prefers generated help facts over raw doc chunks", () => {
    const text = presentAnswer("what is a profile", [
      {
        id: "concepts.md#profiles",
        type: "doc",
        title: "Profiles",
        description: "concepts.md",
        body: "Raw doc chunk text.",
        source: "concepts.md",
      },
      {
        id: "concept.profile",
        type: "doc",
        title: "profile",
        description: "concept",
        body: "Curated profile answer.\nbee auth profiles",
        source: "help:concept",
      },
    ]).text;
    expect(text).toContain("Curated profile answer.");
    expect(text).not.toContain("Raw doc chunk text.");
  });

  it("production corpus still answers concept queries", () => {
    const program = new Command("bee");
    program.command("auth").description("Authentication and profile management").command("profiles").description("List all saved profiles");
    const hits = searchDocs("what is a profile", buildCorpus(program), 10);
    expect(hits.some((h) => h.id === "concept.profile")).toBe(true);
  });
});
