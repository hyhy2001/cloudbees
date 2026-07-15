/**
 * validatePipelineScript handles both response shapes from
 * /pipeline-model-converter/validate.
 *
 * Real Jenkins/CloudBees controllers reply with PLAIN TEXT
 * ("Jenkinsfile successfully validated." / "Errors encountered validating
 * Jenkinsfile:\n..."), which client.post returns as a string. Some versions
 * reply with JSON ({result:"success"|"failure", errors:[...]}), returned as an
 * object. Treating the text form as JSON made every valid pipeline read as a
 * failure and blocked all pipeline creation — these tests pin both forms.
 */

import { describe, test, expect } from "bun:test";
import { validatePipelineScript } from "../src/plugins/job/service";
import type { CloudBeesClient } from "../src/core/api/types";

function clientReturning(value: unknown): CloudBeesClient {
  return {
    async post(_path: string, _opts?: unknown): Promise<unknown> {
      return value;
    },
  } as unknown as CloudBeesClient;
}

function throwingClient(): CloudBeesClient {
  return {
    async post(): Promise<unknown> {
      throw new Error("endpoint not available");
    },
  } as unknown as CloudBeesClient;
}

const SCRIPT = "pipeline { agent any; stages { stage('B') { steps { echo 'x' } } } }";

describe("validatePipelineScript response handling", () => {
  test("plain-text success (real controller form) is valid", async () => {
    const r = await validatePipelineScript(
      clientReturning("Jenkinsfile successfully validated.\n"),
      SCRIPT,
    );
    expect(r.valid).toBe(true);
  });

  test("plain-text error surfaces the message", async () => {
    const r = await validatePipelineScript(
      clientReturning("Errors encountered validating Jenkinsfile:\nline 3: expecting '}'"),
      SCRIPT,
    );
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors[0]).toContain("Errors encountered validating Jenkinsfile");
    }
  });

  test("JSON success form is valid", async () => {
    const r = await validatePipelineScript(clientReturning({ result: "success" }), SCRIPT);
    expect(r.valid).toBe(true);
  });

  test("JSON failure form surfaces errors[]", async () => {
    const r = await validatePipelineScript(
      clientReturning({ result: "failure", errors: [{ error: "bad" }, "plain string err"] }),
      SCRIPT,
    );
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.length).toBe(2);
      expect(r.errors[1]).toBe("plain string err");
    }
  });

  test("endpoint unavailable fails open (valid)", async () => {
    const r = await validatePipelineScript(throwingClient(), SCRIPT);
    expect(r.valid).toBe(true);
  });
});
