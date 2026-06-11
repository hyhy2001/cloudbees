/**
 * getJobConfigSummary now parses description / shell_cmd / chdir / assignedNode
 * so the TUI edit form can prefill real values instead of "leave blank".
 * These guard the round-trip: build a config.xml, serve it, read it back.
 */

import { describe, test, expect } from "bun:test";
import { buildFreestyleXml } from "../src/plugins/job/xml-builder";
import { getJobConfigSummary } from "../src/plugins/job/service";
import type { CloudBeesClient } from "../src/core/api/types";

class FakeClient {
  constructor(private configXml: string) {}
  async getText(_path: string): Promise<string> {
    return this.configXml;
  }
}

function asClient(fake: FakeClient): CloudBeesClient {
  return fake as unknown as CloudBeesClient;
}

describe("getJobConfigSummary — prefill fields", () => {
  test("parses description, shell command, node, and schedule", async () => {
    const xml = buildFreestyleXml({
      desc: "my job",
      shellCmd: "make build",
      node: "linux-agent",
      schedule: "30 9 * * *",
    });
    const s = await getJobConfigSummary(asClient(new FakeClient(xml)), "demo");
    expect(s.description).toBe("my job");
    expect(s.shell_cmd).toBe("make build");
    expect(s.node).toBe("linux-agent");
    expect(s.schedule).toBe("30 9 * * *");
  });

  test("splits a leading 'cd <dir> &&' into chdir + shell_cmd", async () => {
    const xml = buildFreestyleXml({
      shellCmd: "npm test",
      chdir: "/srv/app",
    });
    const s = await getJobConfigSummary(asClient(new FakeClient(xml)), "demo");
    expect(s.chdir).toBe("/srv/app");
    expect(s.shell_cmd).toBe("npm test");
  });

  test("roaming job (no node) yields empty node", async () => {
    const xml = buildFreestyleXml({ shellCmd: "echo hi" });
    const s = await getJobConfigSummary(asClient(new FakeClient(xml)), "demo");
    expect(s.node).toBe("");
    expect(s.chdir).toBe("");
    expect(s.shell_cmd).toBe("echo hi");
  });
});
