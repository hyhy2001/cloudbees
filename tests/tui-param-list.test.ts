/**
 * Pure param-list editor helpers — add/remove/update/finalize StringParamDef[].
 * React-free, no TTY.
 */

import { describe, test, expect } from "bun:test";
import {
  addParam,
  removeParam,
  updateParam,
  finalizeParams,
} from "../src/core/tui/data/param-list";
import type { StringParamDef } from "../src/plugins/job/types";

describe("addParam", () => {
  test("appends a blank row, immutably", () => {
    const a: StringParamDef[] = [];
    const b = addParam(a);
    expect(a.length).toBe(0);
    expect(b).toEqual([{ name: "", defaultValue: "", description: "" }]);
  });
});

describe("removeParam", () => {
  const base: StringParamDef[] = [
    { name: "A", defaultValue: "1" },
    { name: "B", defaultValue: "2" },
  ];
  test("removes the row at index", () => {
    expect(removeParam(base, 0)).toEqual([{ name: "B", defaultValue: "2" }]);
  });
  test("out-of-range index is a no-op copy", () => {
    expect(removeParam(base, 9)).toEqual(base);
    expect(removeParam(base, -1)).toEqual(base);
  });
});

describe("updateParam", () => {
  const base: StringParamDef[] = [{ name: "A", defaultValue: "1" }];
  test("patches one field", () => {
    expect(updateParam(base, 0, "name", "BRANCH")).toEqual([
      { name: "BRANCH", defaultValue: "1" },
    ]);
    expect(updateParam(base, 0, "defaultValue", "main")).toEqual([
      { name: "A", defaultValue: "main" },
    ]);
  });
  test("out-of-range index is a no-op copy", () => {
    expect(updateParam(base, 5, "name", "X")).toEqual(base);
  });
});

describe("finalizeParams", () => {
  test("drops blank-name rows and trims names", () => {
    const input: StringParamDef[] = [
      { name: "  BRANCH ", defaultValue: "main" },
      { name: "", defaultValue: "x" },
      { name: "   ", defaultValue: "y" },
      { name: "VERSION" },
    ];
    expect(finalizeParams(input)).toEqual([
      { name: "BRANCH", defaultValue: "main" },
      { name: "VERSION" },
    ]);
  });
});
