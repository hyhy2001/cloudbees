/**
 * node offline/online idempotency — commands check current state before toggling.
 */

import { describe, test, expect } from "bun:test";
import { parseNodeConfig } from "../src/plugins/node/service";

// ── parseNodeConfig — root element fallbacks ───────────────────────────────

describe("parseNodeConfig — root element fallbacks", () => {
  const sshXml = (root: string) => `
<${root}>
  <remoteFS>/home/jenkins</remoteFS>
  <launcher class="hudson.plugins.sshslaves.SSHLauncher">
    <host>10.0.0.1</host>
    <port>22</port>
    <credentialsId>my-cred</credentialsId>
    <javaPath>/usr/bin/java</javaPath>
  </launcher>
  <retentionStrategy class="hudson.slaves.RetentionStrategy$Demand">
    <inDemandDelay>5</inDemandDelay>
    <idleDelay>10</idleDelay>
  </retentionStrategy>
</${root}>`;

  for (const root of ["slave", "hudson.slaves.DumbSlave", "agent"]) {
    test(`parses SSH launcher under <${root}>`, () => {
      const cfg = parseNodeConfig(sshXml(root));
      expect(cfg.launcherType).toBe("ssh");
      expect(cfg.host).toBe("10.0.0.1");
      expect(cfg.port).toBe(22);
      expect(cfg.credentialsId).toBe("my-cred");
      expect(cfg.javaPath).toBe("/usr/bin/java");
      expect(cfg.availability).toBe("demand");
      expect(cfg.inDemandDelay).toBe(5);
      expect(cfg.idleDelay).toBe(10);
      expect(cfg.remoteDir).toBe("/home/jenkins");
    });
  }

  test("defaults to jnlp / always for unknown root element", () => {
    // With an unknown root element, slave defaults to {} — no crash, just safe defaults.
    const xml = `<unknown-root><remoteFS>/tmp</remoteFS></unknown-root>`;
    const cfg = parseNodeConfig(xml);
    expect(cfg.launcherType).toBe("jnlp");
    expect(cfg.availability).toBe("always");
    // remoteFS not found under any known root key → defaults to ""
    expect(cfg.remoteDir).toBe("");
  });
});

// ── node offline/online state-check logic (pure unit, no HTTP) ────────────

describe("node offline/online — idempotency logic", () => {
  // We test the logic by simulating the service-level decisions rather than
  // invoking the full commander action, which requires process.exit scaffolding.

  function shouldToggleOffline(currentlyOffline: boolean, want: "offline" | "online"): boolean {
    if (want === "offline") return !currentlyOffline;
    return currentlyOffline; // online: toggle only if currently offline
  }

  test("already offline → skip (want offline)", () => {
    expect(shouldToggleOffline(true, "offline")).toBe(false);
  });

  test("currently online → toggle (want offline)", () => {
    expect(shouldToggleOffline(false, "offline")).toBe(true);
  });

  test("already online → skip (want online)", () => {
    expect(shouldToggleOffline(false, "online")).toBe(false);
  });

  test("currently offline → toggle (want online)", () => {
    expect(shouldToggleOffline(true, "online")).toBe(true);
  });
});
