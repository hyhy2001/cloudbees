/**
 * Phase 2 TUI tests — collectScreens registry and screen descriptor contracts.
 *
 * collectScreens() reads BUILTIN_PLUGINS directly (no dynamic loading), so we
 * test the real registry rather than mocking. For sort-order we also exercise
 * the sort logic directly with inline fake Plugin objects.
 */

import { describe, test, expect } from "bun:test";
import type { Plugin, TuiScreen, PluginContext } from "../src/registry/types";
import { collectScreens } from "../src/registry/tui";

// ─── helpers ────────────────────────────────────────────────────────────────

function fakeScreen(id: string, title: string, order: number): TuiScreen {
  return {
    id,
    title,
    order,
    // minimal Component — never rendered in these tests
    Component: () => null as unknown as React.ReactElement,
  };
}

function fakePlugin(id: string, order?: number): Plugin {
  return {
    meta: { name: id, description: "", version: "0.0.0", category: "command" },
    register(_ctx: PluginContext) {},
    ...(order !== undefined
      ? { screen: () => fakeScreen(id, id, order) }
      : {}),
  };
}

// ─── sort logic (unit-test the sort independently of BUILTIN_PLUGINS) ────────

describe("collectScreens sort logic", () => {
  /**
   * Replicate what collectScreens does (iterate plugins, call screen(), sort)
   * but with our own fake plugin array so the test is hermetic.
   */
  function sortScreensFromPlugins(plugins: Plugin[]): TuiScreen[] {
    const screens: TuiScreen[] = [];
    for (const plugin of plugins) {
      if (typeof plugin.screen === "function") {
        screens.push(plugin.screen());
      }
    }
    screens.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    return screens;
  }

  test("plugins without screen() are excluded", () => {
    const plugins = [fakePlugin("cmd-only"), fakePlugin("with-screen", 1)];
    const screens = sortScreensFromPlugins(plugins);
    expect(screens).toHaveLength(1);
    expect(screens[0].id).toBe("with-screen");
  });

  test("screens are sorted by order ascending", () => {
    const plugins = [
      fakePlugin("z-last", 10),
      fakePlugin("a-first", 1),
      fakePlugin("b-mid", 5),
    ];
    const screens = sortScreensFromPlugins(plugins);
    expect(screens.map((s) => s.id)).toEqual(["a-first", "b-mid", "z-last"]);
  });

  test("equal order ties broken alphabetically by title", () => {
    const plugins = [
      fakePlugin("beta", 2),
      fakePlugin("alpha", 2),
      fakePlugin("gamma", 2),
    ];
    const screens = sortScreensFromPlugins(plugins);
    expect(screens.map((s) => s.id)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("single plugin with screen returns one-element array", () => {
    const screens = sortScreensFromPlugins([fakePlugin("only", 1)]);
    expect(screens).toHaveLength(1);
    expect(screens[0].order).toBe(1);
  });

  test("no plugins → empty array", () => {
    expect(sortScreensFromPlugins([])).toEqual([]);
  });
});

// ─── real registry ───────────────────────────────────────────────────────────

describe("collectScreens (real BUILTIN_PLUGINS)", () => {
  test("returns at least one screen", () => {
    const screens = collectScreens();
    expect(screens.length).toBeGreaterThan(0);
  });

  test("jobs screen is present with id='jobs' and order=4", () => {
    const screens = collectScreens();
    const jobs = screens.find((s) => s.id === "jobs");
    expect(jobs).toBeDefined();
    expect(jobs!.order).toBe(4);
    expect(jobs!.title).toBe("Jobs");
  });

  test("all five resource tabs are registered in the expected order", () => {
    const screens = collectScreens();
    // auth is a login modal, not a tab; the five data tabs are 2..6.
    const expected = [
      { id: "controllers", order: 2 },
      { id: "nodes", order: 3 },
      { id: "jobs", order: 4 },
      { id: "credentials", order: 5 },
      { id: "settings", order: 6 },
    ];
    for (const { id, order } of expected) {
      const s = screens.find((x) => x.id === id);
      expect(s, `screen '${id}' should be registered`).toBeDefined();
      expect(s!.order).toBe(order);
    }
    // The registered tab ids, in collected (sorted) order, match the expectation.
    const ids = screens.map((s) => s.id);
    expect(ids).toEqual(expected.map((e) => e.id));
  });

  test("returned screens are sorted by order", () => {
    const screens = collectScreens();
    for (let i = 1; i < screens.length; i++) {
      expect(screens[i].order).toBeGreaterThanOrEqual(screens[i - 1].order);
    }
  });

  test("every screen has required fields (id, title, order, Component)", () => {
    for (const s of collectScreens()) {
      expect(typeof s.id).toBe("string");
      expect(s.id.length).toBeGreaterThan(0);
      expect(typeof s.title).toBe("string");
      expect(typeof s.order).toBe("number");
      expect(typeof s.Component).toBe("function");
    }
  });
});

// ─── jobScreen() descriptor ──────────────────────────────────────────────────

describe("jobScreen descriptor", () => {
  test("has correct static metadata", async () => {
    // Import directly from the plugin to test the descriptor in isolation.
    const { jobScreen } = await import("../src/plugins/job/screen");
    const s = jobScreen();
    expect(s.id).toBe("jobs");
    expect(s.title).toBe("Jobs");
    expect(s.order).toBe(4);
    expect(typeof s.icon).toBe("string");
    expect(s.icon!.length).toBeGreaterThan(0);
    expect(typeof s.Component).toBe("function");
  });
});
