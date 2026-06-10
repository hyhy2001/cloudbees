/**
 * Phase 3 step E — log-buffer pure helpers.
 *
 * appendChunk does chunk-split + ring-buffer capping; colorForLine does the
 * keyword→theme mapping. Both are pure, so they're tested directly (the React
 * LogViewer just calls them inside setState).
 */

import { describe, test, expect } from "bun:test";
import { appendChunk, colorForLine, DEFAULT_MAX_LINES } from "../src/core/tui/data/log-buffer";

describe("appendChunk", () => {
  test("splits a chunk into lines and appends", () => {
    expect(appendChunk([], "a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  test("appends to existing lines", () => {
    expect(appendChunk(["x"], "y\nz")).toEqual(["x", "y", "z"]);
  });

  test("drops a single trailing newline (no spurious empty line)", () => {
    expect(appendChunk([], "a\nb\n")).toEqual(["a", "b"]);
  });

  test("preserves internal blank lines", () => {
    expect(appendChunk([], "a\n\nb")).toEqual(["a", "", "b"]);
  });

  test("empty or undefined chunk returns the same array reference", () => {
    const prev = ["a"];
    expect(appendChunk(prev, "")).toBe(prev);
    expect(appendChunk(prev, undefined)).toBe(prev);
    expect(appendChunk(prev, "\n")).toBe(prev); // only a trailing newline → nothing
  });

  test("caps to max lines, dropping the oldest", () => {
    const prev = Array.from({ length: 5 }, (_, i) => `line${i}`);
    const out = appendChunk(prev, "line5\nline6", 4);
    expect(out).toEqual(["line3", "line4", "line5", "line6"]);
    expect(out).toHaveLength(4);
  });

  test("a single chunk larger than max is itself capped", () => {
    const big = Array.from({ length: 10 }, (_, i) => `L${i}`).join("\n");
    const out = appendChunk([], big, 3);
    expect(out).toEqual(["L7", "L8", "L9"]);
  });

  test("default max is exported and large", () => {
    expect(DEFAULT_MAX_LINES).toBeGreaterThanOrEqual(1000);
  });
});

describe("colorForLine", () => {
  test("error keywords win (case-insensitive)", () => {
    const c = colorForLine("Build FAILED with exception");
    expect(c).toBeDefined();
    expect(colorForLine("error: nope")).toBe(c);
  });

  test("warning maps to a distinct color", () => {
    const warn = colorForLine("WARNING: deprecated");
    const err = colorForLine("ERROR boom");
    expect(warn).toBeDefined();
    expect(warn).not.toBe(err);
  });

  test("success keywords", () => {
    expect(colorForLine("BUILD SUCCESS")).toBeDefined();
    expect(colorForLine("Finished: SUCCESS")).toBeDefined();
  });

  test("pipeline and shell-echo lines are colored", () => {
    expect(colorForLine("[Pipeline] sh")).toBeDefined();
    expect(colorForLine("+ echo hi")).toBeDefined();
  });

  test("error takes priority over warning when both present", () => {
    const both = colorForLine("ERROR and WARNING together");
    expect(both).toBe(colorForLine("ERROR only"));
  });

  test("plain line is unstyled", () => {
    expect(colorForLine("just some output")).toBeUndefined();
  });
});
