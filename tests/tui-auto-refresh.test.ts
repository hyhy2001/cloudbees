/**
 * Phase 3 step F — auto-refresh scheduling logic.
 *
 * nextInterval is the pure backoff decision behind useAutoRefresh: given
 * enabled/active flags and the consecutive-error count, it returns the delay
 * until the next poll (or Infinity = don't schedule). Tested directly; the hook
 * is just a timer wrapper around it.
 */

import { describe, test, expect } from "bun:test";
import { nextInterval, type AutoRefreshPolicy } from "../src/core/tui/data/use-auto-refresh";

const POLICY: AutoRefreshPolicy = { baseMs: 1000, backoffFactor: 2, maxMs: 16000 };

describe("nextInterval — gating", () => {
  test("disabled → Infinity (no schedule)", () => {
    expect(nextInterval(false, true, 0, POLICY)).toBe(Infinity);
  });

  test("inactive tab → Infinity", () => {
    expect(nextInterval(true, false, 0, POLICY)).toBe(Infinity);
  });

  test("enabled + active + healthy → base interval", () => {
    expect(nextInterval(true, true, 0, POLICY)).toBe(1000);
  });
});

describe("nextInterval — backoff", () => {
  test("grows exponentially per consecutive error", () => {
    expect(nextInterval(true, true, 1, POLICY)).toBe(2000);
    expect(nextInterval(true, true, 2, POLICY)).toBe(4000);
    expect(nextInterval(true, true, 3, POLICY)).toBe(8000);
  });

  test("capped at maxMs", () => {
    expect(nextInterval(true, true, 10, POLICY)).toBe(16000);
  });

  test("negative error count treated as healthy", () => {
    expect(nextInterval(true, true, -1, POLICY)).toBe(1000);
  });

  test("defaults: factor 2, cap 60s when unspecified", () => {
    const p: AutoRefreshPolicy = { baseMs: 5000 };
    expect(nextInterval(true, true, 1, p)).toBe(10000);
    expect(nextInterval(true, true, 100, p)).toBe(60000); // hits default cap
  });
});
