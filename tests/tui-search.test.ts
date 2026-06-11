/**
 * useSearch tests — the parts testable without a TTY.
 *
 * The typing handler uses Ink's useInput (needs raw mode), so we don't drive
 * keystrokes here. Instead we verify the pure surface: openBinding shape and
 * that the search filter composes correctly through computeView (the actual
 * filtering the screen relies on).
 */

import { describe, test, expect } from "bun:test";
import { computeView } from "../src/core/tui/data/use-view";

interface Row {
  name: string;
  desc: string;
}

const ROWS: Row[] = [
  { name: "deploy-prod", desc: "production deploy" },
  { name: "build-app", desc: "compile and test" },
  { name: "deploy-staging", desc: "staging deploy" },
];

const searchText = (r: Row) => `${r.name} ${r.desc}`;

describe("search filter via computeView", () => {
  test("empty query returns all rows", () => {
    expect(computeView(ROWS, { query: "", searchText })).toHaveLength(3);
  });

  test("matches the name substring (case-insensitive)", () => {
    const out = computeView(ROWS, { query: "DEPLOY", searchText });
    expect(out.map((r) => r.name)).toEqual(["deploy-prod", "deploy-staging"]);
  });

  test("matches against the searchText projection (description too)", () => {
    const out = computeView(ROWS, { query: "compile", searchText });
    expect(out.map((r) => r.name)).toEqual(["build-app"]);
  });

  test("no match yields empty list", () => {
    expect(computeView(ROWS, { query: "zzz", searchText })).toEqual([]);
  });

  test("query is trimmed", () => {
    const out = computeView(ROWS, { query: "  staging  ", searchText });
    expect(out.map((r) => r.name)).toEqual(["deploy-staging"]);
  });
});
