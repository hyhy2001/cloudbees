/**
 * ResourceStore — the core of the TUI read pipeline.
 *
 * A framework-agnostic, in-memory cache with in-flight dedup and
 * stale-while-revalidate semantics. One entry per key:
 *
 *   service(async) ─► ResourceStore ─► useResource() ─► useView() ─► DataTable
 *
 * Responsibilities (and the legacy pain each removes):
 *  - Dedup: concurrent fetch() for the same key share one in-flight promise
 *    (legacy fired overlapping workers; this collapses them).
 *  - Supersede: a forced refetch aborts the previous request and discards its
 *    result via a generation counter (replaces Textual's `exclusive=True`).
 *  - Stale-while-revalidate: a refetch keeps the previous data visible with
 *    status "stale" until the new data lands — so the table never flickers
 *    blank on refresh (legacy P12).
 *  - TTL freshness: a fetch inside the freshness window is a no-op, so tab
 *    switches and re-renders don't re-hit the network (legacy P1/P2).
 *
 * Deliberately has NO React import so it can be unit-tested in isolation.
 * useResource() (use-resource.ts) is the thin React binding.
 *
 * Note: this is an *in-memory* layer that sits above the SQLite HTTP cache in
 * core/cache. They are complementary — SQLite dedups across process runs and
 * the HTTP layer; ResourceStore dedups across renders/tab switches within a
 * single TUI session and owns the loading/stale/error state machine.
 */

export type ResourceStatus = "idle" | "loading" | "stale" | "data" | "error";

/** Immutable public view of a single resource entry. */
export interface ResourceEntry<T> {
  status: ResourceStatus;
  data: T | undefined;
  error: Error | undefined;
  /** Epoch ms of the last successful fetch, or 0 if never fetched. */
  fetchedAt: number;
}

/** Fetcher receives an AbortSignal so it can bail when superseded. */
export type Fetcher<T> = (signal: AbortSignal) => Promise<T>;

export interface FetchOptions {
  /**
   * Freshness window in ms. If the entry last succeeded within this window the
   * fetch is a no-op (unless `force`). Undefined means "never fresh" — always
   * fetch (subject to in-flight dedup).
   */
  ttlMs?: number;
  /** Bypass the freshness check and refetch now, superseding any in-flight request. */
  force?: boolean;
}

type Listener = () => void;

interface InternalEntry {
  /** Stable snapshot reference — only replaced on change (useSyncExternalStore-safe). */
  snapshot: ResourceEntry<unknown>;
  /** Monotonic counter; a fetch whose generation no longer matches is discarded. */
  generation: number;
  /** In-flight promise (for dedup), or undefined when idle. */
  promise: Promise<void> | undefined;
  /** Controller for the in-flight request, so a supersede can abort it. */
  controller: AbortController | undefined;
  listeners: Set<Listener>;
}

/** Shared frozen idle snapshot returned for unknown keys (stable reference). */
const IDLE_SNAPSHOT: ResourceEntry<unknown> = Object.freeze({
  status: "idle" as const,
  data: undefined,
  error: undefined,
  fetchedAt: 0,
});

export class ResourceStore {
  private entries = new Map<string, InternalEntry>();
  private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now;
  }

  private ensure(key: string): InternalEntry {
    let e = this.entries.get(key);
    if (!e) {
      e = {
        snapshot: IDLE_SNAPSHOT,
        generation: 0,
        promise: undefined,
        controller: undefined,
        listeners: new Set(),
      };
      this.entries.set(key, e);
    }
    return e;
  }

  private emit(e: InternalEntry, snap: ResourceEntry<unknown>): void {
    e.snapshot = snap;
    for (const l of e.listeners) l();
  }

  private isFresh(e: InternalEntry, ttlMs: number | undefined): boolean {
    return (
      e.snapshot.status === "data" &&
      ttlMs !== undefined &&
      this.now() - e.snapshot.fetchedAt < ttlMs
    );
  }

  /** Current snapshot for a key (stable reference between changes). */
  get<T>(key: string): ResourceEntry<T> {
    const e = this.entries.get(key);
    return (e ? e.snapshot : IDLE_SNAPSHOT) as ResourceEntry<T>;
  }

  /** Subscribe to changes for a key. Returns an unsubscribe function. */
  subscribe(key: string, listener: Listener): () => void {
    const e = this.ensure(key);
    e.listeners.add(listener);
    return () => {
      e.listeners.delete(listener);
    };
  }

  /**
   * Fetch (or refetch) a key. Dedups in-flight requests; honors TTL freshness;
   * `force` supersedes any in-flight request and bypasses freshness.
   */
  fetch<T>(key: string, fetcher: Fetcher<T>, opts: FetchOptions = {}): Promise<void> {
    const e = this.ensure(key);
    const { ttlMs, force = false } = opts;

    if (e.promise) {
      if (!force) return e.promise; // dedup: share the in-flight request
      e.controller?.abort(); // supersede: cancel the previous request
    } else if (!force && this.isFresh(e, ttlMs)) {
      return Promise.resolve(); // fresh enough — no network
    }

    const gen = ++e.generation;
    const controller = new AbortController();
    e.controller = controller;

    // stale-while-revalidate: if we already have data, keep showing it as
    // "stale"; otherwise this is a cold load.
    const hasData = e.snapshot.data !== undefined && e.snapshot.status !== "error";
    this.emit(e, {
      status: hasData ? "stale" : "loading",
      data: e.snapshot.data,
      error: undefined,
      fetchedAt: e.snapshot.fetchedAt,
    });

    const run = (async () => {
      try {
        const data = await fetcher(controller.signal);
        if (gen !== e.generation) return; // superseded — discard
        this.emit(e, { status: "data", data, error: undefined, fetchedAt: this.now() });
      } catch (err) {
        if (gen !== e.generation) return; // superseded — discard
        const error = err instanceof Error ? err : new Error(String(err));
        // Keep the last good data alongside the error so the UI can show both.
        this.emit(e, {
          status: "error",
          data: e.snapshot.data,
          error,
          fetchedAt: e.snapshot.fetchedAt,
        });
      } finally {
        if (gen === e.generation) {
          e.promise = undefined;
          e.controller = undefined;
        }
      }
    })();

    e.promise = run;
    return run;
  }

  /**
   * Mark a key not-fresh so the next fetch refetches, keeping current data
   * visible as "stale". Does not itself trigger a network call.
   */
  invalidate(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    const hasData = e.snapshot.data !== undefined;
    this.emit(e, {
      ...e.snapshot,
      status: hasData ? "stale" : "idle",
      fetchedAt: 0, // forces isFresh() to fail next time
    });
  }

  /** Invalidate every key with the given prefix (mirrors cache.invalidatePrefix). */
  invalidatePrefix(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.invalidate(key);
    }
  }

  /** Optimistically set data for a key (e.g. after a mutation). */
  set<T>(key: string, data: T): void {
    const e = this.ensure(key);
    this.emit(e, { status: "data", data, error: undefined, fetchedAt: this.now() });
  }

  /** Test/util: drop all entries. */
  clear(): void {
    this.entries.clear();
  }
}

/** Process-wide singleton used by the TUI. Tests construct their own instances. */
export const resourceStore = new ResourceStore();
