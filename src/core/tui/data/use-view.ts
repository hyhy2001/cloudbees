/**
 * useView — the client-side filter/sort/search stage of the TUI read pipeline.
 *
 *   ResourceStore ─► useResource() ─► useView() ─► DataTable
 *
 * Legacy refetched from the server on every Mine/All toggle, store switch, and
 * had no search at all (P6). useView keeps the full fetched list in hand and
 * derives the visible rows purely in memory: toggling a filter or typing a
 * query never hits the network.
 *
 * Pure and React-agnostic at its core: `computeView()` does the work and is
 * unit-tested directly; `useView()` is a thin memoized React wrapper.
 */

import { useMemo } from "react";

/** A predicate kept in a named map so the UI can toggle filters by key. */
export type Predicate<T> = (item: T) => boolean;

export type SortDirection = "asc" | "desc";

export interface SortSpec<T> {
  /** Comparator returning <0, 0, >0 (asc order). Direction is applied on top. */
  compare: (a: T, b: T) => number;
  direction?: SortDirection;
}

export interface ViewSpec<T> {
  /**
   * Named filters. Only the ones whose key is in `activeFilters` are applied,
   * AND-combined. Keeping them named (rather than a single predicate) lets the
   * screen flip individual filters — Mine/All, store=system, online-only — by
   * key without rebuilding closures.
   */
  filters?: Record<string, Predicate<T>>;
  /** Keys of `filters` to apply. Order irrelevant (AND). */
  activeFilters?: string[];
  /** Free-text query; matched against `searchText(item)`. Case-insensitive. */
  query?: string;
  /** Projects an item to the string searched by `query`. Required for search. */
  searchText?: (item: T) => string;
  /** Optional sort applied after filtering/searching. */
  sort?: SortSpec<T>;
}

/**
 * Pure view computation. Deterministic and side-effect free so it can be tested
 * without React. Returns a NEW array; never mutates the input.
 */
export function computeView<T>(items: readonly T[], spec: ViewSpec<T> = {}): T[] {
  const { filters, activeFilters, query, searchText, sort } = spec;

  let out = items.slice();

  // 1) named filters (AND)
  if (filters && activeFilters && activeFilters.length > 0) {
    const preds = activeFilters
      .map((k) => filters[k])
      .filter((p): p is Predicate<T> => typeof p === "function");
    if (preds.length > 0) {
      out = out.filter((item) => preds.every((p) => p(item)));
    }
  }

  // 2) free-text search (case-insensitive substring)
  const q = query?.trim().toLowerCase();
  if (q && searchText) {
    out = out.filter((item) => searchText(item).toLowerCase().includes(q));
  }

  // 3) sort (stable; Array.prototype.sort is stable in modern engines)
  if (sort) {
    const dir = sort.direction === "desc" ? -1 : 1;
    out.sort((a, b) => sort.compare(a, b) * dir);
  }

  return out;
}

/**
 * React wrapper. Memoizes on the inputs the screen actually varies so holding a
 * key down (cursor moves) doesn't recompute the view. `items` should be the
 * fetched array from useResource; passing a stable reference between renders
 * (which ResourceStore guarantees) keeps this cheap.
 */
export function useView<T>(items: readonly T[] | undefined, spec: ViewSpec<T> = {}): T[] {
  const { filters, activeFilters, query, searchText, sort } = spec;
  return useMemo(
    () => computeView(items ?? [], { filters, activeFilters, query, searchText, sort }),
    // activeFilters is an array; join to a stable primitive for the dep list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, filters, (activeFilters ?? []).join(","), query, searchText, sort],
  );
}
