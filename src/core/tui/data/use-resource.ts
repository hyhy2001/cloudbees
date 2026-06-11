/**
 * useResource — React binding for ResourceStore.
 *
 * Subscribes to a single key via useSyncExternalStore (so the snapshot is
 * always consistent across concurrent renders) and kicks off a fetch on mount
 * and whenever the key changes. Returns the entry plus a `refetch` that forces
 * a superseding reload.
 *
 *   const { status, data, error, refetch } = useResource(
 *     `jobs.list.${baseUrl}`,
 *     (signal) => listJobs(client, signal),
 *     { ttlMs: getTtl("jobs.list") * 1000 },
 *   );
 *
 * The fetcher is intentionally NOT in the effect deps — callers pass a fresh
 * closure each render, and we don't want that to retrigger fetches. The `key`
 * is the cache identity; change the key to refetch with new inputs.
 */

import { useCallback, useEffect, useRef } from "react";
import { useSyncExternalStore } from "react";
import {
  resourceStore as defaultStore,
  type Fetcher,
  type ResourceEntry,
  type ResourceStore,
} from "./resource-store";

/** Options for useResource. */
export interface UseResourceOptions {
  /** Freshness window (ms). Defaults to no TTL (always considered stale). */
  ttlMs?: number;
  /** Skip fetching while false (e.g. tab not yet activated → lazy load). */
  enabled?: boolean;
  /** Override the store (tests). Defaults to the process singleton. */
  store?: ResourceStore;
}

/** Return value of useResource: the ResourceEntry fields plus helpers. */
export interface UseResourceResult<T> extends ResourceEntry<T> {
  /** Force a superseding refetch (bypasses TTL, aborts any in-flight request). */
  refetch: () => Promise<void>;
  /** True while a load is happening with no data to show yet. */
  isInitialLoading: boolean;
}

/**
 * Entry point to the TUI read pipeline. Subscribes to a ResourceStore key via
 * useSyncExternalStore and kicks off a fetch on mount / key change. The fetcher
 * is NOT in the effect deps — change `key` to refetch with different inputs.
 */
export function useResource<T>(
  key: string,
  fetcher: Fetcher<T>,
  opts: UseResourceOptions = {},
): UseResourceResult<T> {
  const { ttlMs, enabled = true, store = defaultStore } = opts;

  // Keep the latest fetcher without making it an effect dependency.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const subscribe = useCallback(
    (cb: () => void) => store.subscribe(key, cb),
    [store, key],
  );
  const getSnapshot = useCallback(
    () => store.get<T>(key),
    [store, key],
  );

  const entry = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Lazy + TTL-aware fetch on mount / key change.
  useEffect(() => {
    if (!enabled) return;
    void store.fetch(key, (signal) => fetcherRef.current(signal), { ttlMs });
  }, [store, key, enabled, ttlMs]);

  const refetch = useCallback(
    () => store.fetch(key, (signal) => fetcherRef.current(signal), { force: true }),
    [store, key],
  );

  return {
    ...entry,
    refetch,
    isInitialLoading: entry.status === "loading",
  };
}
