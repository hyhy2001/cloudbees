/**
 * Tests for docs/config.ts LM provider configuration.
 *
 * The module uses `declare const` for compile-time baked values and
 * `process.env` as fallback. Tests validate the env-var resolution path
 * (the declare-const path is only present in the compiled binary).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { joinUrl } from "../src/plugins/docs/config";

// ─── The pick logic (mirrored from config.ts for testability) ─────────────────

function pick(baked: string | undefined, envKey: string): string {
  if (typeof baked !== "undefined" && baked !== "") return baked;
  const val = process.env[envKey];
  return val ?? "";
}

describe("LM config — pick logic (env resolution)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of ["CB_LM_URL", "CB_API_KEY", "CB_LM_MODEL"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterAll(() => {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  test("no baked value, no env var → empty string", () => {
    expect(pick(undefined, "CB_LM_URL")).toBe("");
  });

  test("baked value takes priority over env var", () => {
    process.env["CB_LM_URL"] = "http://env-host";
    expect(pick("http://baked-host", "CB_LM_URL")).toBe("http://baked-host");
  });

  test("fallback to env var when baked is undefined", () => {
    process.env["CB_LM_URL"] = "http://env-host";
    expect(pick(undefined, "CB_LM_URL")).toBe("http://env-host");
  });

  test("fallback to env var when baked is empty string", () => {
    process.env["CB_LM_URL"] = "http://env-host";
    expect(pick("", "CB_LM_URL")).toBe("http://env-host");
  });

  test("no baked value, no env var → env fallback returns ''", () => {
    expect(pick(undefined, "CB_LM_MODEL")).toBe("");
  });

  test("LM_MODEL defaults to 'default' when both baked and env are empty", () => {
    const model = pick(undefined, "CB_LM_MODEL") || "default";
    expect(model).toBe("default");
  });

  test("LM_MODEL uses env var when set", () => {
    process.env["CB_LM_MODEL"] = "my-model";
    const model = pick(undefined, "CB_LM_MODEL") || "default";
    expect(model).toBe("my-model");
  });
});

describe("joinUrl — collapse duplicated leading path segment", () => {
  test("base ending in /v1 + path starting /v1 does not double", () => {
    expect(joinUrl("http://h:20128/v1", "/v1/chat/completions")).toBe("http://h:20128/v1/chat/completions");
    expect(joinUrl("http://h:20128/v1", "/v1/embeddings")).toBe("http://h:20128/v1/embeddings");
  });

  test("base without /v1 appends path normally", () => {
    expect(joinUrl("http://h:20128", "/v1/chat/completions")).toBe("http://h:20128/v1/chat/completions");
  });

  test("trailing slash on base is trimmed", () => {
    expect(joinUrl("http://h:20128/v1/", "/v1/embeddings")).toBe("http://h:20128/v1/embeddings");
  });

  test("different first segment is NOT stripped (AI Gateway path preserved)", () => {
    expect(joinUrl("https://x.databricks.net", "/ai-gateway/mlflow/v1/chat/completions"))
      .toBe("https://x.databricks.net/ai-gateway/mlflow/v1/chat/completions");
    // base /v1 + path /ai-gateway → first segments differ, no strip
    expect(joinUrl("https://x.databricks.net/v1", "/ai-gateway/v1/chat/completions"))
      .toBe("https://x.databricks.net/v1/ai-gateway/v1/chat/completions");
  });

  test("only collapses one segment, not a shared multi-segment suffix", () => {
    // base ends in /api/v1, path starts /v1 → only /v1 considered as first seg
    expect(joinUrl("http://h/api/v1", "/v1/embeddings")).toBe("http://h/api/v1/embeddings");
  });
});
