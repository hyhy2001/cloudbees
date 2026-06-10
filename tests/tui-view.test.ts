/**
 * Phase 3 step B — useView / computeView pure logic tests.
 *
 * computeView is the client-side filter/sort/search stage. These tests exercise
 * it directly (no React) since the hook is just a memoized wrapper.
 */

import { describe, test, expect } from "bun:test";
import { computeView, type ViewSpec } from "../src/core/tui/data/use-view";

interface Job {
  name: string;
  buildable: boolean;
  color: string;
  lastBuild: number;
}

const JOBS: Job[] = [
  { name: "deploy-prod", buildable: true, color: "blue", lastBuild: 42 },
  { name: "build-app", buildable: true, color: "red", lastBuild: 17 },
  { name: "nightly-scan", buildable: false, color: "disabled", lastBuild: 3 },
  { name: "Deploy-staging", buildable: true, color: "yellow", lastBuild: 8 },
];

describe("computeView — filters", () => {
  const spec: ViewSpec<Job> = {
    filters: {
      buildable: (j) => j.buildable,
      failing: (j) => j.color === "red",
    },
  };

  test("no active filters returns all items", () => {
    expect(computeView(JOBS, spec)).toHaveLength(4);
  });

  test("empty activeFilters array returns all items", () => {
    expect(computeView(JOBS, { ...spec, activeFilters: [] })).toHaveLength(4);
  });

  test("single filter applied", () => {
    const out = computeView(JOBS, { ...spec, activeFilters: ["buildable"] });
    expect(out.map((j) => j.name)).toEqual([
      "deploy-prod",
      "build-app",
      "Deploy-staging",
    ]);
  });

  test("multiple filters are AND-combined", () => {
    const out = computeView(JOBS, { ...spec, activeFilters: ["buildable", "failing"] });
    expect(out.map((j) => j.name)).toEqual(["build-app"]);
  });

  test("unknown filter key is ignored", () => {
    const out = computeView(JOBS, { ...spec, activeFilters: ["nope"] });
    expect(out).toHaveLength(4);
  });
});

describe("computeView — search", () => {
  const spec: ViewSpec<Job> = { searchText: (j) => j.name };

  test("case-insensitive substring match", () => {
    const out = computeView(JOBS, { ...spec, query: "deploy" });
    expect(out.map((j) => j.name)).toEqual(["deploy-prod", "Deploy-staging"]);
  });

  test("query is trimmed", () => {
    const out = computeView(JOBS, { ...spec, query: "  scan  " });
    expect(out.map((j) => j.name)).toEqual(["nightly-scan"]);
  });

  test("empty query returns all", () => {
    expect(computeView(JOBS, { ...spec, query: "" })).toHaveLength(4);
  });

  test("no match returns empty", () => {
    expect(computeView(JOBS, { ...spec, query: "zzz" })).toEqual([]);
  });

  test("query with no searchText projector is a no-op", () => {
    expect(computeView(JOBS, { query: "deploy" })).toHaveLength(4);
  });
});

describe("computeView — sort", () => {
  test("ascending by lastBuild", () => {
    const out = computeView(JOBS, {
      sort: { compare: (a, b) => a.lastBuild - b.lastBuild },
    });
    expect(out.map((j) => j.lastBuild)).toEqual([3, 8, 17, 42]);
  });

  test("descending by lastBuild", () => {
    const out = computeView(JOBS, {
      sort: { compare: (a, b) => a.lastBuild - b.lastBuild, direction: "desc" },
    });
    expect(out.map((j) => j.lastBuild)).toEqual([42, 17, 8, 3]);
  });

  test("stable for equal keys", () => {
    const items = [
      { name: "a", k: 1 },
      { name: "b", k: 1 },
      { name: "c", k: 1 },
    ];
    const out = computeView(items, { sort: { compare: (a, b) => a.k - b.k } });
    expect(out.map((i) => i.name)).toEqual(["a", "b", "c"]);
  });
});

describe("computeView — combined + purity", () => {
  test("filter then search then sort", () => {
    const out = computeView(JOBS, {
      filters: { buildable: (j) => j.buildable },
      activeFilters: ["buildable"],
      query: "deploy",
      searchText: (j) => j.name,
      sort: { compare: (a, b) => a.lastBuild - b.lastBuild, direction: "desc" },
    });
    expect(out.map((j) => j.name)).toEqual(["deploy-prod", "Deploy-staging"]);
  });

  test("does not mutate the input array", () => {
    const input = JOBS.slice();
    const snapshot = JSON.stringify(input);
    computeView(input, {
      sort: { compare: (a, b) => a.lastBuild - b.lastBuild },
      filters: { buildable: (j) => j.buildable },
      activeFilters: ["buildable"],
    });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test("empty input returns empty", () => {
    expect(computeView([], { query: "x", searchText: (s: string) => s })).toEqual([]);
  });
});
