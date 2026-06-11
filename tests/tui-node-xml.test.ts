/**
 * Node XML builder + config parse tests (no network).
 *
 * Covers buildLauncherXml (ssh/jnlp), buildRetentionXml (always/demand),
 * and parseNodeConfig round-tripping the launcher + retention subtrees.
 */

import { describe, test, expect } from "bun:test";
import {
  buildLauncherXml,
  buildRetentionXml,
  buildPermanentNodeXml,
} from "../src/plugins/node/xml-builder";
import { parseNodeConfig } from "../src/plugins/node/service";

describe("buildLauncherXml", () => {
  test("ssh launcher carries host/port/cred/java", () => {
    const xml = buildLauncherXml({
      type: "ssh",
      host: "agent.example.com",
      port: 2222,
      credentialsId: "my-cred",
      javaPath: "/usr/bin/java",
    });
    expect(xml).toContain('class="hudson.plugins.sshslaves.SSHLauncher"');
    expect(xml).toContain("<host>agent.example.com</host>");
    expect(xml).toContain("<port>2222</port>");
    expect(xml).toContain("<credentialsId>my-cred</credentialsId>");
    expect(xml).toContain("<javaPath>/usr/bin/java</javaPath>");
  });

  test("jnlp launcher emits workDirSettings block", () => {
    const xml = buildLauncherXml({ type: "jnlp" });
    expect(xml).toContain('class="hudson.slaves.JNLPLauncher"');
    expect(xml).toContain("<workDirSettings>");
    expect(xml).toContain("<internalDir>remoting</internalDir>");
  });

  test("ssh host is XML-escaped", () => {
    const xml = buildLauncherXml({ type: "ssh", host: "a&b<c" });
    expect(xml).toContain("a&amp;b&lt;c");
  });
});

describe("buildRetentionXml", () => {
  test("always is self-closing", () => {
    const xml = buildRetentionXml({ availability: "always" });
    expect(xml).toContain('class="hudson.slaves.RetentionStrategy$Always"');
    expect(xml.trim().endsWith("/>")).toBe(true);
  });

  test("demand carries inDemandDelay + idleDelay", () => {
    const xml = buildRetentionXml({ availability: "demand", inDemandDelay: 5, idleDelay: 3 });
    expect(xml).toContain('class="hudson.slaves.RetentionStrategy$Demand"');
    expect(xml).toContain("<inDemandDelay>5</inDemandDelay>");
    expect(xml).toContain("<idleDelay>3</idleDelay>");
  });

  test("demand defaults to 0/1 when delays omitted", () => {
    const xml = buildRetentionXml({ availability: "demand" });
    expect(xml).toContain("<inDemandDelay>0</inDemandDelay>");
    expect(xml).toContain("<idleDelay>1</idleDelay>");
  });
});

describe("parseNodeConfig", () => {
  test("round-trips an ssh + demand config", () => {
    const xml = [
      "<?xml version='1.1' encoding='UTF-8'?>",
      "<slave>",
      "  <name>n1</name>",
      "  <remoteFS>/home/jenkins</remoteFS>",
      "  <numExecutors>2</numExecutors>",
      buildRetentionXml({ availability: "demand", inDemandDelay: 4, idleDelay: 7 }),
      buildLauncherXml({ type: "ssh", host: "h.example", port: 2200, credentialsId: "c1", javaPath: "/jp" }),
      "  <label>linux</label>",
      "</slave>",
    ].join("\n");

    const cfg = parseNodeConfig(xml);
    expect(cfg.launcherType).toBe("ssh");
    expect(cfg.host).toBe("h.example");
    expect(cfg.port).toBe(2200);
    expect(cfg.credentialsId).toBe("c1");
    expect(cfg.javaPath).toBe("/jp");
    expect(cfg.availability).toBe("demand");
    expect(cfg.inDemandDelay).toBe(4);
    expect(cfg.idleDelay).toBe(7);
  });

  test("jnlp + always config parses with defaults", () => {
    const xml = buildPermanentNodeXml("n2", "/home/j", 1, "lbl", "desc");
    const cfg = parseNodeConfig(xml);
    expect(cfg.launcherType).toBe("jnlp");
    expect(cfg.availability).toBe("always");
    expect(cfg.host).toBe("");
    expect(cfg.port).toBe(22);
  });

  test("tolerates missing launcher/retention (returns defaults)", () => {
    const cfg = parseNodeConfig("<slave><name>n</name></slave>");
    expect(cfg.launcherType).toBe("jnlp");
    expect(cfg.availability).toBe("always");
  });
});
