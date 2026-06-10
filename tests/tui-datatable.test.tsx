/**
 * Phase 2 TUI tests — DataTable render and BeeApp not-logged-in state.
 *
 * Uses ink-testing-library `render` to get the terminal frame output.
 * We test content only (headers, cell text, empty state) — not keypress
 * simulation, since there is no TTY in the test environment and useInput
 * guards on `isActive`.
 */

import React from "react";
import { describe, test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { DataTable } from "../src/core/tui/components/DataTable";
import { BeeApp } from "../src/core/tui/app";
import { TuiProvider } from "../src/core/tui/context";
import type { TuiScreen } from "../src/registry/types";

// ─── DataTable ────────────────────────────────────────────────────────────────

const COLS = [
  { header: "Name", width: 20 },
  { header: "Status", width: 10 },
];

const ROWS = [
  [{ text: "my-job" }, { text: "OK" }],
  [{ text: "other-job" }, { text: "FAIL" }],
  [{ text: "third-job" }, { text: "WARN" }],
];

describe("DataTable", () => {
  test("renders column headers", () => {
    const { lastFrame } = render(
      <DataTable
        columns={COLS}
        rows={ROWS}
        cursor={0}
        onCursorChange={() => {}}
        active={false}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Name");
    expect(frame).toContain("Status");
  });

  test("renders cell text from rows", () => {
    const { lastFrame } = render(
      <DataTable
        columns={COLS}
        rows={ROWS}
        cursor={0}
        onCursorChange={() => {}}
        active={false}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("my-job");
    expect(frame).toContain("other-job");
    expect(frame).toContain("third-job");
    expect(frame).toContain("OK");
    expect(frame).toContain("FAIL");
    expect(frame).toContain("WARN");
  });

  test("renders default empty-state text when rows is empty", () => {
    const { lastFrame } = render(
      <DataTable
        columns={COLS}
        rows={[]}
        cursor={0}
        onCursorChange={() => {}}
        active={false}
      />,
    );
    const frame = lastFrame() ?? "";
    // Default emptyText prop is "(no rows)"
    expect(frame).toContain("(no rows)");
  });

  test("renders custom emptyText when provided", () => {
    const { lastFrame } = render(
      <DataTable
        columns={COLS}
        rows={[]}
        cursor={0}
        onCursorChange={() => {}}
        active={false}
        emptyText="No jobs. Press n to create one."
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("No jobs. Press n to create one.");
  });

  test("does not render empty-state text when rows are present", () => {
    const { lastFrame } = render(
      <DataTable
        columns={COLS}
        rows={ROWS}
        cursor={0}
        onCursorChange={() => {}}
        active={false}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("(no rows)");
  });

  test("shows scroll hint when rows exceed height", () => {
    // height defaults to 12; create 15 rows to trigger the scroll hint
    const manyRows = Array.from({ length: 15 }, (_, i) => [
      { text: `job-${i}` },
      { text: "OK" },
    ]);
    const { lastFrame } = render(
      <DataTable
        columns={COLS}
        rows={manyRows}
        cursor={0}
        onCursorChange={() => {}}
        active={false}
      />,
    );
    const frame = lastFrame() ?? "";
    // Scroll hint format is "cursor+1/total"
    expect(frame).toContain("/15");
  });

  test("does not show scroll hint when rows fit within height", () => {
    const { lastFrame } = render(
      <DataTable
        columns={COLS}
        rows={ROWS}
        cursor={0}
        onCursorChange={() => {}}
        active={false}
        height={12}
      />,
    );
    const frame = lastFrame() ?? "";
    // ROWS has 3 entries, all fit; no "/" scroll hint
    expect(frame).not.toContain("/3");
  });
});

// ─── BeeApp not-logged-in ─────────────────────────────────────────────────────

/**
 * A minimal no-op screen so BeeApp has something to render in the tab bar.
 * The Component is never fully interactive in tests (no TTY), so a plain div
 * suffices.
 */
const stubScreen: TuiScreen = {
  id: "stub",
  title: "Stub",
  order: 1,
  Component: () => <></>,
};

function renderBeeApp(loggedIn: boolean) {
  return render(
    <TuiProvider
      initialSession={{
        username: loggedIn ? "alice" : "",
        activeController: null,
        loggedIn,
      }}
    >
      <BeeApp screens={[stubScreen]} />
    </TuiProvider>,
  );
}

describe("BeeApp header — not logged in", () => {
  test("shows 'not logged in' in the header when loggedIn=false", () => {
    const { lastFrame } = renderBeeApp(false);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("not logged in");
  });

  test("does not show 'not logged in' when loggedIn=true", () => {
    const { lastFrame } = renderBeeApp(true);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("not logged in");
  });

  test("shows the username in the header when logged in", () => {
    const { lastFrame } = renderBeeApp(true);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("alice");
  });

  test("tab bar renders the screen title", () => {
    const { lastFrame } = renderBeeApp(false);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Stub");
  });
});
