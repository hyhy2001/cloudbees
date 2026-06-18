import { describe, it, expect } from "bun:test";
import { presentAnswer } from "../src/plugins/docs/presenter";
import type { DocItem } from "../src/plugins/docs/corpus";

const JOB_RUN: DocItem = {
  id: "job.run",
  type: "command",
  title: "bee job run <name>",
  description: "Trigger a job build",
  body: "--wait                      Wait for build to finish\n--timeout <seconds>         Max wait time in seconds",
  source: "command",
};

const JOB_STOP: DocItem = {
  id: "job.stop",
  type: "command",
  title: "bee job stop <name>",
  description: "Stop a running build",
  body: "--wait                      Wait for job to fully stop",
  source: "command",
};

const PROFILE_DOC: DocItem = {
  id: "concept.profile",
  type: "doc",
  title: "Profiles",
  description: "internal",
  body: "A profile is a saved identity for one server URL, username, and encrypted token. Use profiles to switch quickly.",
  source: "internal",
};

describe("presentAnswer", () => {
  it("renders command answer with title, description and flags", () => {
    const text = presentAnswer("run a build", [JOB_RUN, PROFILE_DOC]).text;
    expect(text).toContain("bee job run <name>");
    expect(text).toContain("Trigger a job build");
    expect(text).toContain("--wait");
    expect(text).not.toContain("internal");
  });

  it("renders doc answer with body text and related commands", () => {
    const text = presentAnswer("what is a profile", [PROFILE_DOC, JOB_RUN, JOB_STOP]).text;
    expect(text).toContain("A profile is a saved identity");
    expect(text).not.toContain("concept.profile");
    expect(text).not.toContain("internal");
  });

  it("renders no-result message", () => {
    const text = presentAnswer("xyzzy", []).text;
    expect(text).toContain("No results");
  });
});
