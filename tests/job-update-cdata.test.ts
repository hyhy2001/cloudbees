/**
 * updateJobFreestyle — CDATA-safe XML shell command patching.
 */

import { describe, test, expect } from "bun:test";
import { updateJobFreestyle } from "../src/plugins/job/service";
import type { CloudBeesClient } from "../src/core/api/types";

// ── Minimal fake client ────────────────────────────────────────────────────

class FakeClient {
  posted: Array<{ path: string; xml: string }> = [];
  constructor(private xml: string) {}
  async getText(_path: string): Promise<string> { return this.xml; }
  async postXml(path: string, xml: string): Promise<void> {
    this.posted.push({ path, xml });
  }
}
function asClient(c: FakeClient): CloudBeesClient {
  return c as unknown as CloudBeesClient;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeProjectXml(commandSection: string): string {
  return `<?xml version="1.0"?>
<project>
  <description>test</description>
  <builders>
    <hudson.tasks.Shell>
      ${commandSection}
    </hudson.tasks.Shell>
  </builders>
</project>`;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("updateJobFreestyle — CDATA shell patching", () => {
  test("replaces plain-text <command> content", async () => {
    const xml = makeProjectXml("<command>echo old</command>");
    const c = new FakeClient(xml);
    await updateJobFreestyle(asClient(c), "job1", { shellCmd: "echo new" });
    expect(c.posted).toHaveLength(1);
    const out = c.posted[0]!.xml;
    expect(out).toContain("<command>echo new</command>");
    expect(out).not.toContain("echo old");
  });

  test("replaces CDATA <command> content and keeps CDATA wrapper", async () => {
    const xml = makeProjectXml("<command><![CDATA[echo old && ls]]></command>");
    const c = new FakeClient(xml);
    await updateJobFreestyle(asClient(c), "job1", { shellCmd: "echo replaced" });
    expect(c.posted).toHaveLength(1);
    const out = c.posted[0]!.xml;
    expect(out).toContain("<command><![CDATA[echo replaced]]></command>");
    expect(out).not.toContain("echo old");
  });

  test("CDATA with multiline script", async () => {
    const script = "#!/bin/bash\nset -e\necho hello";
    const xml = makeProjectXml("<command><![CDATA[old script]]></command>");
    const c = new FakeClient(xml);
    await updateJobFreestyle(asClient(c), "job1", { shellCmd: script });
    const out = c.posted[0]!.xml;
    expect(out).toContain(`<command><![CDATA[${script}]]></command>`);
  });

  test("injects new <builders> section when none exists", async () => {
    const xml = `<?xml version="1.0"?>
<project>
  <description>test</description>
</project>`;
    const c = new FakeClient(xml);
    await updateJobFreestyle(asClient(c), "job1", { shellCmd: "echo injected" });
    const out = c.posted[0]!.xml;
    expect(out).toContain("<command>echo injected</command>");
    expect(out).toContain("<hudson.tasks.Shell>");
  });

  test("XML-escapes special chars in plain-text replacement", async () => {
    const xml = makeProjectXml("<command>echo old</command>");
    const c = new FakeClient(xml);
    await updateJobFreestyle(asClient(c), "job1", { shellCmd: "echo a<b>&c" });
    const out = c.posted[0]!.xml;
    expect(out).toContain("<command>echo a&lt;b&gt;&amp;c</command>");
  });
});

describe("updateJobFreestyle — opts interface", () => {
  test("only provided opts are applied (desc only)", async () => {
    const xml = makeProjectXml("<command>echo original</command>");
    const c = new FakeClient(xml);
    await updateJobFreestyle(asClient(c), "job1", { desc: "new desc" });
    const out = c.posted[0]!.xml;
    // shell command unchanged
    expect(out).toContain("echo original");
    expect(out).toContain("<description>new desc</description>");
  });

  test("empty opts object posts unchanged XML", async () => {
    const xml = makeProjectXml("<command>echo original</command>");
    const c = new FakeClient(xml);
    await updateJobFreestyle(asClient(c), "job1", {});
    // no email/schedule/etc to update → still posts (XML passthrough)
    expect(c.posted).toHaveLength(1);
    expect(c.posted[0]!.xml).toContain("echo original");
  });
});
