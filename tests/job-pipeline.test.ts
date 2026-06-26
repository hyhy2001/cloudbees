/**
 * Pipeline job tests — pipeline-parse, xml-builder, service (create/update).
 * Follows patterns from email-filters.test.ts (FakeClient, XML inspection).
 */

import { describe, test, expect } from "bun:test";
import { XMLParser } from "fast-xml-parser";
import {
  parseParametersFromScript,
  parseAgentFromScript,
  injectAgent,
} from "../src/domain/pipeline-parse";
import { buildPipelineXml } from "../src/plugins/job/xml-builder";
import type { PipelineXmlOpts } from "../src/plugins/job/types";
import {
  createPipelineJob,
  updatePipelineJob,
  validatePipelineScript,
  getPipelineScript,
} from "../src/plugins/job/service";
import type { CloudBeesClient } from "../src/core/api/types";
import { NotFoundError } from "../src/core/api/errors";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MIN_SCRIPT =
  "pipeline { agent any; stages { stage('Build') { steps { echo 'hello' } } } }";

const SCRIPT_WITH_PARAMS = `pipeline {
  agent any
  parameters {
    string(name: 'BRANCH', defaultValue: 'main', description: 'Branch name')
    booleanParam(name: 'DEBUG', defaultValue: true)
    choice(name: 'ENV', choices: ['dev', 'staging', 'prod'])
    text(name: 'NOTES', defaultValue: '')
    password(name: 'TOKEN', defaultValue: 's3cr3t')
  }
  stages { stage('Build') { steps { echo "branch: \${params.BRANCH}" } } }
}`;

const SCRIPT_WITH_AGENT = `pipeline {
  agent { label 'linux' }
  stages { stage('Build') { steps { echo 'hi' } } }
}`;

const SCRIPT_NESTED_AGENT = `pipeline {
  agent { docker { image 'node:18' } }
  stages { stage('Build') { steps { echo 'ok' } } }
}`;

// ─── Fake client (modeled after email-filters.test.ts) ────────────────────────

class FakePipelineClient {
  configXml: string;
  posted: Array<{ path: string; xml: string; invalidate?: string }> = [];
  validationResult: unknown = { result: "success" };

  constructor(configXml = "") {
    this.configXml = configXml;
  }

  get baseUrl(): string {
    return "http://jenkins.example.com";
  }

  get token(): string {
    return "dGVzdDp0ZXN0"; // base64 "test:test"
  }

  async getText(_path: string): Promise<string> {
    return this.configXml;
  }

  async postXml(
    path: string,
    xml: string,
    opts?: { invalidate?: string },
  ): Promise<string | null> {
    this.posted.push({ path, xml, invalidate: opts?.invalidate });
    return null;
  }

  async get<T>(path: string, _opts?: unknown): Promise<T> {
    // job detail endpoint → not found so duplicate-check passes
    if (path.includes("/api/json")) throw new NotFoundError("not found");
    return {} as T;
  }

  async post<T>(path: string, _opts?: unknown): Promise<T> {
    if (path.includes("/pipeline-model-converter/validate")) {
      if (this.validationResult instanceof Error) throw this.validationResult;
      return this.validationResult as T;
    }
    return {} as T;
  }
}

function asClient(c: FakePipelineClient): CloudBeesClient {
  return c as unknown as CloudBeesClient;
}

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse XML and return the text content of a nested path (e.g. "definition.script"). */
function xmlText(xml: string, path: string): string | null {
  try {
    const doc = parser.parse(xml) as Record<string, unknown>;
    const parts = path.split(".");
    let node: unknown = doc;
    for (const p of parts) {
      node = (node as Record<string, unknown>)?.[p];
      if (node == null) return null;
    }
    return typeof node === "string" ? node : null;
  } catch {
    return null;
  }
}

/** Build a pipeline config.xml string for testing updatePipelineJob. */
function makePipelineXml(overrides: Partial<PipelineXmlOpts> & { script?: string }): string {
  return buildPipelineXml({
    desc: overrides.desc ?? "test job",
    script: overrides.script ?? MIN_SCRIPT,
    schedule: overrides.schedule ?? null,
    email: overrides.email ?? null,
    emailCond: overrides.emailCond ?? "failed",
    emailKeywords: overrides.emailKeywords ?? null,
    emailRegex: overrides.emailRegex ?? null,
    params: overrides.params ?? null,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// pipeline-parse.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe("parseParametersFromScript", () => {
  test("empty script returns []", () => {
    expect(parseParametersFromScript("")).toEqual([]);
  });

  test("no parameters block returns []", () => {
    expect(parseParametersFromScript(MIN_SCRIPT)).toEqual([]);
  });

  test("parses string parameter with name/default/description", () => {
    const script = `pipeline {
      parameters { string(name: 'BRANCH', defaultValue: 'main', description: 'Branch name') }
      stages { stage('B') { steps { echo '' } } }
    }`;
    expect(parseParametersFromScript(script)).toEqual([
      { name: "BRANCH", defaultValue: "main", description: "Branch name" },
    ]);
  });

  test("parses string parameter with only name", () => {
    const script = `pipeline {
      parameters { string(name: 'X') }
      stages { stage('B') { steps { echo '' } } }
    }`;
    expect(parseParametersFromScript(script)).toEqual([
      { name: "X", defaultValue: "", description: "" },
    ]);
  });

  test("parses booleanParam with default true", () => {
    const script = `parameters {
      booleanParam(name: 'DEBUG', defaultValue: true)
    }`;
    expect(parseParametersFromScript(script)).toEqual([
      { name: "DEBUG", defaultValue: "true", description: "" },
    ]);
  });

  test("parses booleanParam with default false", () => {
    const script = `parameters {
      booleanParam(name: 'OFF', defaultValue: false)
    }`;
    expect(parseParametersFromScript(script)).toEqual([
      { name: "OFF", defaultValue: "false", description: "" },
    ]);
  });

  test("parses booleanParam without defaultValue defaults to false", () => {
    const script = `parameters {
      booleanParam(name: 'FLAG')
    }`;
    expect(parseParametersFromScript(script)).toEqual([
      { name: "FLAG", defaultValue: "false", description: "" },
    ]);
  });

  test("parses choice; first choice becomes defaultValue", () => {
    const script = `parameters {
      choice(name: 'ENV', choices: ['dev', 'staging', 'prod'])
    }`;
    const params = parseParametersFromScript(script);
    expect(params).toHaveLength(1);
    expect(params[0]!.name).toBe("ENV");
    expect(params[0]!.defaultValue).toBe("dev");
  });

  test("parses choice with no choices returns empty default", () => {
    const script = `parameters {
      choice(name: 'X', choices: [])
    }`;
    expect(parseParametersFromScript(script)).toEqual([
      { name: "X", defaultValue: "", description: "" },
    ]);
  });

  test("parses text parameter", () => {
    const script = `parameters {
      text(name: 'NOTES', defaultValue: 'long text')
    }`;
    expect(parseParametersFromScript(script)).toEqual([
      { name: "NOTES", defaultValue: "long text", description: "" },
    ]);
  });

  test("parses password parameter", () => {
    const script = `parameters {
      password(name: 'SECRET', defaultValue: 's3cr3t')
    }`;
    expect(parseParametersFromScript(script)).toEqual([
      { name: "SECRET", defaultValue: "s3cr3t", description: "" },
    ]);
  });

  test("parses multiple parameter types in one block", () => {
    const params = parseParametersFromScript(SCRIPT_WITH_PARAMS);
    expect(params).toHaveLength(5);
    expect(params[0]).toEqual({ name: "BRANCH", defaultValue: "main", description: "Branch name" });
    expect(params[1]).toEqual({ name: "DEBUG", defaultValue: "true", description: "" });
    expect(params[2]!.name).toBe("ENV");
    expect(params[3]).toEqual({ name: "NOTES", defaultValue: "", description: "" });
    expect(params[4]).toEqual({ name: "TOKEN", defaultValue: "s3cr3t", description: "" });
  });
});

describe("parseAgentFromScript", () => {
  test("agent { label 'name' } returns the label", () => {
    expect(parseAgentFromScript(SCRIPT_WITH_AGENT)).toBe("linux");
  });

  test("agent { label \"name\" } with double quotes", () => {
    const s = `pipeline { agent { label "windows" } stages { stage('B') { steps { echo '' } } } }`;
    expect(parseAgentFromScript(s)).toBe("windows");
  });

  test("agent any returns 'any'", () => {
    expect(parseAgentFromScript(MIN_SCRIPT)).toBe("any");
  });

  test("agent none returns 'none'", () => {
    const s = `pipeline { agent none; stages { stage('B') { steps { echo '' } } } }`;
    expect(parseAgentFromScript(s)).toBe("none");
  });

  test("no agent directive returns null", () => {
    const s = `pipeline { stages { stage('B') { steps { echo '' } } } }`;
    expect(parseAgentFromScript(s)).toBeNull();
  });

  test("agent with docker block (nested braces) returns null (not a label)", () => {
    expect(parseAgentFromScript(SCRIPT_NESTED_AGENT)).toBeNull();
  });

  // Regex parser doesn't handle comments — `agent any` inside `/* */` still matches.
  // This is a documented limitation ("Good enough for well-formed Declarative syntax").
});

describe("injectAgent", () => {
  test("replaces existing agent { label 'old' } block", () => {
    const result = injectAgent(SCRIPT_WITH_AGENT, "new-label");
    expect(result).toContain("agent { label 'new-label' }");
    expect(result).not.toContain("agent { label 'linux' }");
  });

  test("replaces bare agent any", () => {
    const result = injectAgent(MIN_SCRIPT, "my-node");
    expect(result).toContain("agent { label 'my-node' }");
    expect(result).not.toContain("agent any");
  });

  test("replaces bare agent none", () => {
    const s = `pipeline { agent none; stages { stage('B') { steps { echo '' } } } }`;
    const result = injectAgent(s, "my-node");
    expect(result).toContain("agent { label 'my-node' }");
    expect(result).not.toContain("agent none");
  });

  test("injects after pipeline { when no agent directive", () => {
    const s = `pipeline { stages { stage('B') { steps { echo '' } } } }`;
    const result = injectAgent(s, "my-node");
    expect(result).toContain("pipeline {\n  agent { label 'my-node' }");
  });

  test("returns unchanged when no pipeline { at all", () => {
    const s = `echo hello`;
    expect(injectAgent(s, "x")).toBe(s);
  });

  test("handles nested braces in existing agent block (docker)", () => {
    const result = injectAgent(SCRIPT_NESTED_AGENT, "new-label");
    expect(result).toContain("agent { label 'new-label' }");
    expect(result).not.toContain("docker");
  });

  test("empty script returns unchanged", () => {
    expect(injectAgent("", "x")).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildPipelineXml
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildPipelineXml", () => {
  test("default minimal output", () => {
    const xml = buildPipelineXml({});
    expect(xml).toContain("<?xml version='1.1' encoding='UTF-8'?>");
    expect(xml).toContain("<flow-definition plugin=\"workflow-job@2.40\">");
    expect(xml).toContain("<sandbox>true</sandbox>");
    expect(xml).toContain("CpsFlowDefinition");
    expect(xml).toContain("echo &apos;hello&apos;");
  });

  test("with description", () => {
    const xml = buildPipelineXml({ desc: "my pipeline" });
    expect(xmlText(xml, "flow-definition.description")).toBe("my pipeline");
  });

  test("with schedule embeds timer trigger", () => {
    const xml = buildPipelineXml({ schedule: "H 8 * * *" });
    expect(xml).toContain("TimerTrigger");
    expect(xml).toContain("H 8 * * *");
  });

  test("with email embeds publisher block", () => {
    const xml = buildPipelineXml({
      email: "team@example.com",
      emailCond: "failed",
    });
    expect(xml).toContain("ExtendedEmailPublisher");
    expect(xml).toContain("team@example.com");
  });

  test("with email and keywords embeds presend script", () => {
    const xml = buildPipelineXml({
      email: "team@example.com",
      emailKeywords: ["error", "fail"],
    });
    expect(xml).toContain("ExtendedEmailPublisher");
    expect(xml).toContain("presendScript");
    expect(xml).toContain("error");
  });

  test("with params embeds ParametersDefinitionProperty", () => {
    const xml = buildPipelineXml({
      params: [{ name: "BRANCH", defaultValue: "main" }],
    });
    expect(xml).toContain("ParametersDefinitionProperty");
    expect(xml).toContain("StringParameterDefinition");
    expect(xml).toContain("<name>BRANCH</name>");
  });

  test("with schedule + email + params together", () => {
    const xml = buildPipelineXml({
      desc: "full pipeline",
      script: MIN_SCRIPT,
      schedule: "H 8 * * *",
      email: "a@b.com",
      params: [{ name: "X", defaultValue: "y" }],
    });
    expect(xml).toContain("TimerTrigger");
    expect(xml).toContain("ExtendedEmailPublisher");
    expect(xml).toContain("StringParameterDefinition");
    expect(xml).toContain("H 8 * * *");
  });

  test("XML-escapes special chars in script", () => {
    const xml = buildPipelineXml({ script: "pipeline { stages { stage('B') { steps { echo '<tag>&\"' } } } }" });
    expect(xml).toContain("&lt;tag&gt;&amp;&quot;");
  });

  test("empty params yields self-closing properties", () => {
    const xml = buildPipelineXml({ params: [] });
    expect(xml).toContain("<properties/>");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// validatePipelineScript
// ═══════════════════════════════════════════════════════════════════════════════

describe("validatePipelineScript", () => {
  test("valid script returns { valid: true }", async () => {
    const client = asClient(new FakePipelineClient());
    const result = await validatePipelineScript(client, MIN_SCRIPT);
    expect(result).toEqual({ valid: true });
  });

  test("invalid script returns { valid: false, errors }", async () => {
    const client = new FakePipelineClient();
    client.validationResult = {
      result: "failure",
      errors: [{ message: "expected 'pipeline' block" }],
    };
    const result = await validatePipelineScript(asClient(client), "bad script");
    expect(result).toEqual({ valid: false, errors: ["expected 'pipeline' block"] });
  });

  test("server unavailable (fail open) returns { valid: true }", async () => {
    // When the POST throws (network error, 404), the function degrades to { valid: true }.
    const client = new FakePipelineClient();
    client.validationResult = new Error("Network error");
    const result = await validatePipelineScript(asClient(client), MIN_SCRIPT);
    expect(result).toEqual({ valid: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createPipelineJob
// ═══════════════════════════════════════════════════════════════════════════════

describe("createPipelineJob", () => {
  test("minimal creates with default XML structure", async () => {
    const client = new FakePipelineClient();
    await createPipelineJob(asClient(client), "my-pipe", {
      script: MIN_SCRIPT,
    });
    expect(client.posted).toHaveLength(1);
    const { path, xml } = client.posted[0]!;
    expect(path).toContain("/createItem?name=my-pipe");
    expect(xml).toContain("<flow-definition");
    expect(xml).toContain("&apos;hello&apos;");
  });

  test("with all opts stores correct XML", async () => {
    const client = new FakePipelineClient();
    await createPipelineJob(asClient(client), "full-pipe", {
      desc: "my pipeline",
      script: MIN_SCRIPT,
      node: "linux",
      schedule: "H 8 * * *",
      email: "a@b.com",
      emailCond: "failed",
      emailKeywords: ["error"],
      params: [{ name: "X", defaultValue: "y" }],
    });
    const xml = client.posted[0]!.xml;
    expect(xml).toContain("<description>my pipeline</description>");
    expect(xml).toContain("TimerTrigger");
    expect(xml).toContain("ExtendedEmailPublisher");
    expect(xml).toContain("StringParameterDefinition");
    expect(xml).toContain("agent { label &apos;linux&apos; }");
  });

  test("node flag triggers injectAgent in script", async () => {
    const client = new FakePipelineClient();
    await createPipelineJob(asClient(client), "node-pipe", {
      script: SCRIPT_WITH_AGENT,
      node: "windows",
    });
    const xml = client.posted[0]!.xml;
    expect(xml).toContain("agent { label &apos;windows&apos; }");
    expect(xml).not.toContain("agent { label &apos;linux&apos; }");
  });

  test("auto-detects params from script", async () => {
    const client = new FakePipelineClient();
    await createPipelineJob(asClient(client), "param-pipe", {
      script: SCRIPT_WITH_PARAMS,
    });
    const xml = client.posted[0]!.xml;
    // BRANCH, DEBUG, ENV, NOTES, TOKEN all become StringParameterDefinition
    expect(xml).toContain("<name>BRANCH</name>");
    expect(xml).toContain("<defaultValue>main</defaultValue>");
    expect(xml).toContain("<name>DEBUG</name>");
    expect(xml).toContain("<defaultValue>true</defaultValue>");
    expect(xml).toContain("<name>ENV</name>");
    expect(xml).toContain("<name>NOTES</name>");
    expect(xml).toContain("<name>TOKEN</name>");
  });

  test("CLI params merge with detected params (override)", async () => {
    const client = new FakePipelineClient();
    await createPipelineJob(asClient(client), "merge-pipe", {
      script: SCRIPT_WITH_PARAMS,
      params: [{ name: "BRANCH", defaultValue: "develop" }],
    });
    const xml = client.posted[0]!.xml;
    expect(xml).toContain("<defaultValue>develop</defaultValue>");
  });

  test("CLI-only params appended to detected params", async () => {
    const client = new FakePipelineClient();
    await createPipelineJob(asClient(client), "extra-pipe", {
      script: MIN_SCRIPT,
      params: [{ name: "EXTRA", defaultValue: "value" }],
    });
    const xml = client.posted[0]!.xml;
    expect(xml).toContain("<name>EXTRA</name>");
    expect(xml).toContain("<defaultValue>value</defaultValue>");
  });

  test("throws when script is empty", async () => {
    const client = asClient(new FakePipelineClient());
    expect(
      createPipelineJob(client, "bad", { script: "" }),
    ).rejects.toThrow("Pipeline script is required");
  });

  test("in a folder passes folder path to API", async () => {
    const client = new FakePipelineClient();
    await createPipelineJob(asClient(client), "fld-pipe", {
      script: MIN_SCRIPT,
    }, "team/backend");
    const path = client.posted[0]!.path;
    expect(path).toContain("/job/team/job/backend/createItem");
  });

  test("validates script before creating", async () => {
    const client = new FakePipelineClient();
    client.validationResult = {
      result: "failure",
      errors: [{ message: "syntax error" }],
    };
    await expect(
      createPipelineJob(asClient(client), "bad", { script: "bad script" }),
    ).rejects.toThrow("Pipeline script validation failed");
  });

  test("rejects duplicate job name", async () => {
    const client = new FakePipelineClient();
    // Override get to return a job (simulates existing job)
    client.get = async <T>(_path: string, _opts?: unknown): Promise<T> => ({} as T);
    await expect(
      createPipelineJob(asClient(client), "existing", { script: MIN_SCRIPT }),
    ).rejects.toThrow(`Job "existing" already exists.`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// updatePipelineJob
// ═══════════════════════════════════════════════════════════════════════════════

describe("updatePipelineJob", () => {
  test("updates description only (preserves script)", async () => {
    const client = new FakePipelineClient(makePipelineXml({}));
    await updatePipelineJob(asClient(client), "my-pipe", {
      desc: "new description",
    });
    const xml = client.posted[0]!.xml;
    expect(xmlText(xml, "flow-definition.description")).toBe("new description");
    // Script should still be present
    expect(xml).toContain("&apos;hello&apos;");
  });

  test("replaces script entirely", async () => {
    const client = new FakePipelineClient(makePipelineXml({}));
    await updatePipelineJob(asClient(client), "my-pipe", {
      script: `pipeline { agent any; stages { stage('Deploy') { steps { echo 'deploy' } } } }`,
    });
    const xml = client.posted[0]!.xml;
    expect(xml).toContain("&apos;deploy&apos;");
    expect(xml).not.toContain("&apos;hello&apos;");
  });

  test("changes node (re-injects agent)", async () => {
    const client = new FakePipelineClient(makePipelineXml({ script: SCRIPT_WITH_AGENT }));
    await updatePipelineJob(asClient(client), "my-pipe", { node: "windows" });
    const xml = client.posted[0]!.xml;
    expect(xml).toContain("agent { label &apos;windows&apos; }");
    expect(xml).not.toContain("agent { label &apos;linux&apos; }");
  });

  test("changes schedule", async () => {
    const client = new FakePipelineClient(makePipelineXml({ schedule: "H 8 * * *" }));
    await updatePipelineJob(asClient(client), "my-pipe", { schedule: "H 12 * * *" });
    const xml = client.posted[0]!.xml;
    expect(xml).toContain("H 12 * * *");
    expect(xml).not.toContain("H 8 * * *");
  });

  test("changes email without touching schedule", async () => {
    const client = new FakePipelineClient(makePipelineXml({
      schedule: "H 8 * * *",
      email: "old@example.com",
    }));
    await updatePipelineJob(asClient(client), "my-pipe", {
      email: "new@example.com",
    });
    const xml = client.posted[0]!.xml;
    // Email updated
    expect(xml).toContain("new@example.com");
    expect(xml).not.toContain("old@example.com");
    // Schedule untouched
    expect(xml).toContain("H 8 * * *");
  });

  test("clears params", async () => {
    const client = new FakePipelineClient(makePipelineXml({
      params: [{ name: "OLD", defaultValue: "val" }],
    }));
    await updatePipelineJob(asClient(client), "my-pipe", { clearParams: true });
    const xml = client.posted[0]!.xml;
    expect(xml).toContain("<properties/>");
  });

  test("validates new script before applying", async () => {
    const client = new FakePipelineClient(makePipelineXml({}));
    client.validationResult = {
      result: "failure",
      errors: [{ message: "bad script" }],
    };
    await expect(
      updatePipelineJob(asClient(client), "my-pipe", { script: "bad" }),
    ).rejects.toThrow("Pipeline script validation failed");
  });

  test("throws when job is not a pipeline (no flow-definition root)", async () => {
    const client = new FakePipelineClient(
      "<?xml version='1.1' encoding='UTF-8'?><project><description>freestyle</description></project>"
    );
    await expect(
      updatePipelineJob(asClient(client), "my-pipe", { desc: "x" }),
    ).rejects.toThrow("not a Pipeline");
  });

  test("round-trip: preserves omitted fields", async () => {
    const client = new FakePipelineClient(makePipelineXml({
      desc: "original",
      schedule: "H 8 * * *",
      email: "a@b.com",
    }));
    await updatePipelineJob(asClient(client), "my-pipe", { desc: "changed" });
    const xml = client.posted[0]!.xml;
    expect(xmlText(xml, "flow-definition.description")).toBe("changed");
    // Schedule and email are read from existing XML and preserved
    expect(xml).toContain("H 8 * * *");
    expect(xml).toContain("a@b.com");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getPipelineScript
// ═══════════════════════════════════════════════════════════════════════════════

describe("getPipelineScript", () => {
  test("returns script from a valid pipeline config.xml", async () => {
    const client = new FakePipelineClient(makePipelineXml({ script: MIN_SCRIPT }));
    const result = await getPipelineScript(asClient(client), "my-pipe");
    expect(result).toContain("echo 'hello'");
  });

  test("returns null when job is not a pipeline", async () => {
    const client = new FakePipelineClient(
      "<?xml version='1.1' encoding='UTF-8'?><project><description>freestyle</description></project>"
    );
    const result = await getPipelineScript(asClient(client), "my-pipe");
    expect(result).toBeNull();
  });

  test("returns null when config.xml has no definition", async () => {
    const client = new FakePipelineClient(
      "<?xml version='1.1' encoding='UTF-8'?><flow-definition><description>empty</description></flow-definition>"
    );
    const result = await getPipelineScript(asClient(client), "my-pipe");
    expect(result).toBeNull();
  });
});
