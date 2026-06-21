/**
 * CLI output formatter tests — core/cli/output.ts.
 * Tests table, kv, and message formatters for both table and JSON output modes.
 */
import { describe, test, expect } from "bun:test";
import { tableFormatter, jsonFormatter, theme, printError } from "../src/core/cli/output";
import { AuthError } from "../src/core/api/errors";

describe("tableFormatter", () => {
  test("table renders headers and rows", () => {
    const out = tableFormatter.table(["Name", "Type"], [["job-A", "FS"], ["job-B", "PL"]]);
    expect(out).toContain("Name");
    expect(out).toContain("Type");
    expect(out).toContain("job-A");
    expect(out).toContain("job-B");
  });

  test("table handles empty rows", () => {
    const out = tableFormatter.table(["A", "B"], []);
    expect(out).toContain("A");
    expect(out).toContain("B");
  });

  test("kv renders key-value pairs", () => {
    const out = tableFormatter.kv({ name: "my-job", type: "FS" });
    expect(out).toContain("name");
    expect(out).toContain("my-job");
    expect(out).toContain("type");
    expect(out).toContain("FS");
  });

  test("kv handles empty data", () => {
    const out = tableFormatter.kv({});
    expect(out).toContain("(no data)");
  });

  test("kv coerce non-string values", () => {
    const out = tableFormatter.kv({ count: 42, active: true, value: null });
    expect(out).toContain("42");
    expect(out).toContain("true");
  });

  test("message formats with level colors", () => {
    expect(tableFormatter.message("hello", "info")).toBe(theme.info("hello"));
    expect(tableFormatter.message("hello", "error")).toBe(theme.error("hello"));
    expect(tableFormatter.message("hello", "success")).toBe(theme.success("hello"));
    expect(tableFormatter.message("hello", "warning")).toBe(theme.warning("hello"));
  });
});

describe("jsonFormatter", () => {
  test("table renders as JSON array", () => {
    const out = jsonFormatter.table(["Name", "Type"], [["a", "FS"], ["b", "PL"]]);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ Name: "a", Type: "FS" });
    expect(parsed[1]).toEqual({ Name: "b", Type: "PL" });
  });

  test("kv renders as JSON object", () => {
    const out = jsonFormatter.kv({ name: "my-job", count: 42 });
    expect(JSON.parse(out)).toEqual({ name: "my-job", count: 42 });
  });

  test("message renders as JSON with message key", () => {
    const out = jsonFormatter.message("done");
    expect(JSON.parse(out)).toEqual({ message: "done" });
  });
});

describe("theme", () => {
  test("all theme colors are functions producing strings", () => {
    for (const [name, fn] of Object.entries(theme)) {
      const result = fn("test");
      expect(typeof result).toBe("string");
      expect(result).toContain("test");
    }
  });
});
