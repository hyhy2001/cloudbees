/**
 * ResourceStore unit tests (no React) — Step A of the TUI pipeline.
 *
 * Covers: cold load, in-flight dedup, supersede + abort via force, TTL
 * freshness no-op, stale-while-revalidate on refetch, error keeps last data,
 * invalidate / invalidatePrefix, optimistic set, subscribe/unsubscribe.
 */

import { describe, test, expect } from "bun:test";
import { ResourceStore } from "../src/core/tui/data/resource-store";

// A controllable deferred so tests can decide when a fetch resolves.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ResourceStore — cold load", () => {
  test("unknown key reads as idle", () => {
    const s = new ResourceStore();
    const e = s.get("missing");
    expect(e.status).toBe("idle");
    expect(e.data).toBeUndefined();
  });

  test("loading then data", async () => {
    const s = new ResourceStore();
    const d = deferred<number[]>();
    const p = s.fetch("k", () => d.promise);
    expect(s.get("k").status).toBe("loading");
    d.resolve([1, 2, 3]);
    await p;
    const e = s.get<number[]>("k");
    expect(e.status).toBe("data");
    expect(e.data).toEqual([1, 2, 3]);
    expect(e.fetchedAt).toBeGreaterThan(0);
  });
});

describe("ResourceStore — in-flight dedup", () => {
  test("concurrent fetches for same key share one request", async () => {
    const s = new ResourceStore();
    let calls = 0;
    const d = deferred<string>();
    const fetcher = () => {
      calls++;
      return d.promise;
    };
    const p1 = s.fetch("k", fetcher);
    const p2 = s.fetch("k", fetcher);
    expect(p1).toBe(p2); // same promise returned
    expect(calls).toBe(1); // fetcher invoked once
    d.resolve("ok");
    await p1;
    expect(calls).toBe(1);
  });
});

describe("ResourceStore — supersede via force", () => {
  test("force aborts the previous request and discards its result", async () => {
    const s = new ResourceStore();
    const d1 = deferred<string>();
    let signal1: AbortSignal | undefined;
    s.fetch("k", (sig) => {
      signal1 = sig;
      return d1.promise;
    });

    const d2 = deferred<string>();
    const p2 = s.fetch("k", () => d2.promise, { force: true });
    expect(signal1?.aborted).toBe(true); // previous request signalled to abort

    // Late resolution of the first (superseded) request must be ignored.
    d1.resolve("STALE");
    await Promise.resolve();
    expect(s.get<string>("k").data).not.toBe("STALE");

    d2.resolve("FRESH");
    await p2;
    expect(s.get<string>("k").data).toBe("FRESH");
  });
});

describe("ResourceStore — TTL freshness", () => {
  test("fetch within ttl window is a no-op", async () => {
    let t = 1000;
    const s = new ResourceStore({ now: () => t });
    let calls = 0;
    await s.fetch("k", () => {
      calls++;
      return Promise.resolve("v");
    });
    expect(calls).toBe(1);

    t = 1500; // 500ms later, within 1000ms ttl
    await s.fetch("k", () => {
      calls++;
      return Promise.resolve("v2");
    }, { ttlMs: 1000 });
    expect(calls).toBe(1); // skipped — still fresh
    expect(s.get<string>("k").data).toBe("v");

    t = 2100; // now beyond the window
    await s.fetch("k", () => {
      calls++;
      return Promise.resolve("v3");
    }, { ttlMs: 1000 });
    expect(calls).toBe(2);
    expect(s.get<string>("k").data).toBe("v3");
  });

  test("force bypasses ttl", async () => {
    const t = 1000;
    const s = new ResourceStore({ now: () => t });
    let calls = 0;
    const f = () => {
      calls++;
      return Promise.resolve("v");
    };
    await s.fetch("k", f, { ttlMs: 100000 });
    await s.fetch("k", f, { ttlMs: 100000, force: true });
    expect(calls).toBe(2);
  });
});

describe("ResourceStore — stale-while-revalidate", () => {
  test("refetch keeps previous data visible as 'stale'", async () => {
    const s = new ResourceStore();
    await s.fetch("k", () => Promise.resolve(["a"]));
    expect(s.get<string[]>("k").status).toBe("data");

    const d = deferred<string[]>();
    const p = s.fetch("k", () => d.promise, { force: true });
    const mid = s.get<string[]>("k");
    expect(mid.status).toBe("stale");
    expect(mid.data).toEqual(["a"]); // old data still shown

    d.resolve(["a", "b"]);
    await p;
    expect(s.get<string[]>("k").status).toBe("data");
    expect(s.get<string[]>("k").data).toEqual(["a", "b"]);
  });
});

describe("ResourceStore — errors", () => {
  test("cold error has status error and no data", async () => {
    const s = new ResourceStore();
    await s.fetch("k", () => Promise.reject(new Error("boom")));
    const e = s.get("k");
    expect(e.status).toBe("error");
    expect(e.error?.message).toBe("boom");
    expect(e.data).toBeUndefined();
  });

  test("error after data keeps the last good data", async () => {
    const s = new ResourceStore();
    await s.fetch("k", () => Promise.resolve(["good"]));
    await s.fetch("k", () => Promise.reject(new Error("net")), { force: true });
    const e = s.get<string[]>("k");
    expect(e.status).toBe("error");
    expect(e.data).toEqual(["good"]); // preserved
    expect(e.error?.message).toBe("net");
  });

  test("non-Error rejection is wrapped", async () => {
    const s = new ResourceStore();
    await s.fetch("k", () => Promise.reject("string failure"));
    expect(s.get("k").error).toBeInstanceOf(Error);
    expect(s.get("k").error?.message).toBe("string failure");
  });
});

describe("ResourceStore — invalidate", () => {
  test("invalidate marks data stale and forces next fetch", async () => {
    let t = 1000;
    const s = new ResourceStore({ now: () => t });
    let calls = 0;
    const f = () => {
      calls++;
      return Promise.resolve("v");
    };
    await s.fetch("k", f, { ttlMs: 100000 });
    expect(calls).toBe(1);

    s.invalidate("k");
    expect(s.get("k").status).toBe("stale");

    await s.fetch("k", f, { ttlMs: 100000 }); // would be fresh, but invalidated
    expect(calls).toBe(2);
  });

  test("invalidatePrefix hits only matching keys", async () => {
    const s = new ResourceStore();
    await s.fetch("jobs.list.A", () => Promise.resolve(1));
    await s.fetch("jobs.list.B", () => Promise.resolve(2));
    await s.fetch("nodes.list.A", () => Promise.resolve(3));

    s.invalidatePrefix("jobs.");
    expect(s.get("jobs.list.A").status).toBe("stale");
    expect(s.get("jobs.list.B").status).toBe("stale");
    expect(s.get("nodes.list.A").status).toBe("data"); // untouched
  });
});

describe("ResourceStore — optimistic set", () => {
  test("set writes data immediately", () => {
    const s = new ResourceStore();
    s.set("k", { name: "x" });
    const e = s.get<{ name: string }>("k");
    expect(e.status).toBe("data");
    expect(e.data).toEqual({ name: "x" });
  });
});

describe("ResourceStore — subscriptions", () => {
  test("listeners fire on change and stop after unsubscribe", async () => {
    const s = new ResourceStore();
    let hits = 0;
    const unsub = s.subscribe("k", () => {
      hits++;
    });
    await s.fetch("k", () => Promise.resolve("v")); // loading + data = 2 emits
    expect(hits).toBeGreaterThanOrEqual(2);

    const after = hits;
    unsub();
    await s.fetch("k", () => Promise.resolve("v2"), { force: true });
    expect(hits).toBe(after); // no more notifications
  });

  test("snapshot reference is stable between changes", () => {
    const s = new ResourceStore();
    s.set("k", [1]);
    const a = s.get("k");
    const b = s.get("k");
    expect(a).toBe(b); // same reference → useSyncExternalStore-safe
  });
});
