/**
 * resolveColumnWidths — flex column sizing for DataTable.
 * Pure, React-free.
 */

import { describe, test, expect } from "bun:test";
import { resolveColumnWidths, type Column } from "../src/core/tui/components/DataTable";

const cols: Column[] = [
  { header: "", width: 2 },
  { header: "Name", width: 10 },
  { header: "Description", width: 20, flex: true },
];

describe("resolveColumnWidths", () => {
  test("no tableWidth → declared widths verbatim", () => {
    expect(resolveColumnWidths(cols)).toEqual([2, 10, 20]);
  });

  test("no flex columns → declared widths verbatim even with tableWidth", () => {
    const fixed: Column[] = [
      { header: "a", width: 5 },
      { header: "b", width: 5 },
    ];
    expect(resolveColumnWidths(fixed, 200)).toEqual([5, 5]);
  });

  test("flex column expands to fill leftover width", () => {
    // chrome = 2 + 3 cols = 5; fixed = 2 + 10 = 12; leftover = 100-5-12 = 83.
    // one flex col → max(20, 83) = 83.
    expect(resolveColumnWidths(cols, 100)).toEqual([2, 10, 83]);
  });

  test("two flex columns split leftover evenly", () => {
    const two: Column[] = [
      { header: "", width: 2 },
      { header: "A", width: 10, flex: true },
      { header: "B", width: 10, flex: true },
    ];
    // chrome = 2+3 = 5; fixed = 2; leftover = 100-5-2 = 93; each = floor(93/2)=46.
    expect(resolveColumnWidths(two, 100)).toEqual([2, 46, 46]);
  });

  test("narrow terminal falls back to declared minimums", () => {
    // leftover would be <= sum of flex minimums → no growth.
    expect(resolveColumnWidths(cols, 20)).toEqual([2, 10, 20]);
  });
});
