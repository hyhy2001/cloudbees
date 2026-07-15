/**
 * updateCredential targets the correct secret tag per credential type.
 *
 * SecretText (StringCredentialsImpl) stores its value in <secret>; UsernamePassword
 * in <password>. Writing the wrong tag inserts a dead element Jenkins ignores while
 * the real secret stays unchanged — a silent no-op that reports success (a rotated
 * token would stay live). These tests capture the posted config.xml and assert the
 * value lands in the tag the fetched XML actually has.
 */

import { describe, test, expect } from "bun:test";
import { updateCredential } from "../src/plugins/credential/service";
import type { CloudBeesClient } from "../src/core/api/types";

class CaptureClient {
  posted: string | null = null;
  constructor(private xml: string) {}
  async getText(_path: string): Promise<string> {
    return this.xml;
  }
  async postXml(_path: string, xml: string): Promise<string | null> {
    this.posted = xml;
    return null;
  }
}

function asClient(c: CaptureClient): CloudBeesClient {
  return c as unknown as CloudBeesClient;
}

const secretTextXml = `<?xml version='1.1' encoding='UTF-8'?>
<org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl>
  <scope>GLOBAL</scope>
  <id>tok</id>
  <description>old desc</description>
  <secret>OLD_SECRET</secret>
</org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl>`;

const usernamePasswordXml = `<?xml version='1.1' encoding='UTF-8'?>
<com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>
  <scope>GLOBAL</scope>
  <id>up</id>
  <description>old desc</description>
  <username>alice</username>
  <password>OLD_PASS</password>
</com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>`;

describe("updateCredential secret tag targeting", () => {
  test("SecretText: new value replaces <secret>, no dead <password> inserted", async () => {
    const c = new CaptureClient(secretTextXml);
    await updateCredential(asClient(c), "tok", undefined, "NEW_SECRET");
    expect(c.posted).not.toBeNull();
    expect(c.posted).toContain("<secret>NEW_SECRET</secret>");
    expect(c.posted).not.toContain("OLD_SECRET");
    // The bug inserted a <password> element that Jenkins ignores.
    expect(c.posted).not.toContain("<password>");
  });

  test("UsernamePassword: new value replaces <password>", async () => {
    const c = new CaptureClient(usernamePasswordXml);
    await updateCredential(asClient(c), "up", undefined, "NEW_PASS");
    expect(c.posted).not.toBeNull();
    expect(c.posted).toContain("<password>NEW_PASS</password>");
    expect(c.posted).not.toContain("OLD_PASS");
  });

  test("SecretText with class attribute on <secret> still targets it", async () => {
    const withAttr = secretTextXml.replace(
      "<secret>",
      '<secret class="hudson.util.Secret">',
    );
    const c = new CaptureClient(withAttr);
    await updateCredential(asClient(c), "tok", undefined, "ROTATED");
    expect(c.posted).toContain("ROTATED");
    expect(c.posted).not.toContain("OLD_SECRET");
    expect(c.posted).not.toContain("<password>");
  });

  // The real-world input: Jenkins redacts the secret on read-back, so the GET
  // returns <secret><secret-redacted/></secret> — never the ciphertext. The old
  // code left this redacted placeholder untouched (only writing <password>), so
  // the secret was never rotated. The fix must replace the redacted content.
  test("SecretText redacted read-back form gets its value rotated", async () => {
    const redacted = `<?xml version='1.1' encoding='UTF-8'?>
<org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl plugin="plain-credentials@199">
  <scope>GLOBAL</scope>
  <id>tok</id>
  <description></description>
  <secret>
    <secret-redacted/>
  </secret>
</org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl>`;
    const c = new CaptureClient(redacted);
    await updateCredential(asClient(c), "tok", undefined, "ROTATED_VALUE");
    expect(c.posted).toContain("<secret>ROTATED_VALUE</secret>");
    expect(c.posted).not.toContain("secret-redacted");
    expect(c.posted).not.toContain("<password>");
  });
});
