/**
 * Plugin service tests — controller, auth, node, credential (server-side logic).
 * Pure unit tests using FakeClient (no network, no DB).
 */
import { describe, test, expect } from "bun:test";
import type { CloudBeesClient } from "../src/core/api/types";
import { XMLParser } from "fast-xml-parser";

const xml = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

// ─── Fake client ──────────────────────────────────────────────────────────────

class FakeSvcClient {
  responses: Map<string, unknown> = new Map();
  posted: Array<{ path: string; body?: unknown }> = [];

  get baseUrl(): string { return "http://jenkins.example.com"; }
  get token(): string { return "dGVzdDp0ZXN0"; }

  setResponse(path: string, data: unknown): void {
    this.responses.set(path, data);
  }

  async getText(path: string): Promise<string> {
    const val = this.responses.get(path);
    return typeof val === "string" ? val : "";
  }

  async get<T>(_path: string): Promise<T> {
    const val = this.responses.get(_path);
    return (val ?? null) as T;
  }

  async post(_path: string, _opts?: { body?: unknown; headers?: Record<string, string> }): Promise<unknown> {
    this.posted.push({ path: _path, body: _opts?.body });
    return {};
  }
}

function asClient(c: FakeSvcClient): CloudBeesClient {
  return c as unknown as CloudBeesClient;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Auth service
// ═══════════════════════════════════════════════════════════════════════════════

describe("auth service", () => {
  test("buildBasicToken returns base64-encoded credentials", async () => {
    const { buildBasicToken } = await import("../src/plugins/auth/service");
    expect(buildBasicToken("admin", "s3cr3t")).toBe("YWRtaW46czNjcjN0");
  });

  test("buildBasicToken with special characters", async () => {
    const { buildBasicToken } = await import("../src/plugins/auth/service");
    expect(buildBasicToken("user@domain", "tok:en")).toBe("dXNlckBkb21haW46dG9rOmVu");
  });

  test("buildBasicToken with empty password", async () => {
    const { buildBasicToken } = await import("../src/plugins/auth/service");
    expect(buildBasicToken("root", "")).toBe("cm9vdDo=");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Node service
// ═══════════════════════════════════════════════════════════════════════════════

describe("node service", () => {
  test("listNodes returns NodeDTOs from API response", async () => {
    const { listNodes } = await import("../src/plugins/node/service");
    const client = new FakeSvcClient();
    const apiTree = "computer[displayName,offline,numExecutors,assignedLabels[name],description]";
    client.setResponse(`/computer/api/json?tree=${apiTree}`, {
      computer: [
        { displayName: "agent-1", offline: false, numExecutors: 2, assignedLabels: [{ name: "linux" }], description: "" },
      ],
    });
    const nodes = await listNodes(asClient(client));
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.name).toBe("agent-1");
    expect(nodes[0]!.numExecutors).toBe(2);
  });

  test("listNodes returns empty array on empty response", async () => {
    const { listNodes } = await import("../src/plugins/node/service");
    const client = new FakeSvcClient();
    const apiTree = "computer[displayName,offline,numExecutors,assignedLabels[name],description]";
    client.setResponse(`/computer/api/json?tree=${apiTree}`, {});
    const nodes = await listNodes(asClient(client));
    expect(nodes).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Credential service
// ═══════════════════════════════════════════════════════════════════════════════

describe("credential service", () => {
  test("getCredentialConfig extracts username and description from XML", async () => {
    const { getCredentialConfig } = await import("../src/plugins/credential/service");
    const client = new FakeSvcClient();
    const credXml = `<?xml version='1.1' encoding='UTF-8'?>
      <com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>
        <username>admin</username>
        <description>my cred</description>
      </com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>`;
    // Default store="system" → path = "/credentials/store/system/domain/_/credential/test-id/config.xml"
    client.setResponse("/credentials/store/system/domain/_/credential/test-id/config.xml", credXml);
    const config = await getCredentialConfig(asClient(client), "test-id");
    expect(config.username).toBe("admin");
    expect(config.description).toBe("my cred");
  });

  test("getCredentialConfig returns empty strings for missing credential", async () => {
    const { getCredentialConfig } = await import("../src/plugins/credential/service");
    const client = new FakeSvcClient();
    client.setResponse("/credentials/store/system/domain/_/credential/none/config.xml", "");
    const config = await getCredentialConfig(asClient(client), "none");
    expect(config.username).toBe("");
    expect(config.description).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// XML builders (node, credential)
// ═══════════════════════════════════════════════════════════════════════════════

describe("credential XML builders", () => {
  test("buildUsernamePasswordCredXml", async () => {
    const { buildUsernamePasswordCredXml } = await import("../src/plugins/credential/xml-builder");
    const xml = buildUsernamePasswordCredXml("my-cred", "admin", "s3cr3t", "Admin cred", "GLOBAL");
    expect(xml).toContain("UsernamePasswordCredentialsImpl");
    expect(xml).toContain("<username>admin</username>");
    expect(xml).toContain("<password>s3cr3t</password>");
    expect(xml).toContain("<id>my-cred</id>");
  });

  test("buildSecretTextCredXml", async () => {
    const { buildSecretTextCredXml } = await import("../src/plugins/credential/xml-builder");
    const xml = buildSecretTextCredXml("api-token", "tok-abc-123", "API Token", "GLOBAL");
    expect(xml).toContain("StringCredentialsImpl");
    expect(xml).toContain("<secret>tok-abc-123</secret>");
    expect(xml).toContain("<id>api-token</id>");
  });
});

describe("node XML builders", () => {
  test("buildLauncherXml with SSH", async () => {
    const { buildLauncherXml } = await import("../src/plugins/node/xml-builder");
    const xml = buildLauncherXml({
      type: "ssh",
      host: "10.0.0.1",
      port: 22,
      credentialsId: "ssh-key",
      javaPath: "/usr/bin/java",
    });
    expect(xml).toContain("SSHLauncher");
    expect(xml).toContain("10.0.0.1");
    expect(xml).toContain("ssh-key");
  });

  test("buildLauncherXml with JNLP", async () => {
    const { buildLauncherXml } = await import("../src/plugins/node/xml-builder");
    const xml = buildLauncherXml({ type: "jnlp" });
    expect(xml).toContain("JNLPLauncher");
  });

  test("buildRetentionXml with always", async () => {
    const { buildRetentionXml } = await import("../src/plugins/node/xml-builder");
    const xml = buildRetentionXml({ availability: "always" });
    expect(xml).toContain("Always");
  });

  test("buildRetentionXml with demand", async () => {
    const { buildRetentionXml } = await import("../src/plugins/node/xml-builder");
    const xml = buildRetentionXml({ availability: "demand", inDemandDelay: 2, idleDelay: 5 });
    expect(xml).toContain("Demand");
    expect(xml).toContain("2");
    expect(xml).toContain("5");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Controller service — lightweight import check
// ═══════════════════════════════════════════════════════════════════════════════

describe("controller service", () => {
  test("exports expected API functions", async () => {
    const svc = await import("../src/plugins/controller/service");
    expect(svc.listControllers).toBeFunction();
    expect(svc.getController).toBeFunction();
    expect(svc.selectController).toBeFunction();
    expect(svc.getControllerCapabilities).toBeFunction();
    expect(svc.getControllerInfo).toBeFunction();
  });
});
