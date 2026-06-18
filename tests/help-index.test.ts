import { describe, it, expect } from "bun:test";
import { HELP_FACTS } from "../src/generated/help-index";
import { buildCorpus, searchDocs } from "../src/plugins/docs/corpus";
import { Command } from "commander";

describe("generated help index", () => {
  it("contains curated help facts", () => {
    expect(HELP_FACTS.length).toBeGreaterThan(0);
    expect(HELP_FACTS.some((f) => f.id === "concept.profile")).toBe(true);
  });

  it("help facts are searchable through corpus", () => {
    const program = new Command("bee");
    program.command("auth").description("Authentication and profile management").command("profiles").description("List all saved profiles");
    const hits = searchDocs("what is a profile", buildCorpus(program), 10);
    expect(hits.some((h) => h.id === "concept.profile")).toBe(true);
  });
});
