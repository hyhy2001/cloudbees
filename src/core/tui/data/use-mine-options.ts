/**
 * useMineOptions — fetch a cross-resource list and reduce it to the "Mine"
 * (tracked) subset for use as a FormModal dropdown's `options`.
 *
 * Used so a node-edit form can offer a credential picker, and a job form a
 * node picker, both scoped to the tracked-resource list (the same Mine filter
 * the tables use). Fetches in the background once `enabled` turns true, so the
 * options are ready by the time the user opens the modal.
 *
 * FormModal returns the selected option string verbatim, so the option values
 * ARE the names/ids. A leading "(none)" sentinel lets the user pick "unset";
 * the screen maps it back to "" when submitting (see NONE_OPTION).
 */

import { useEffect, useState } from "react";

/** Sentinel option meaning "no selection"; screens map it back to "". */
export const NONE_OPTION = "(none)";

export interface MineOptionsParams {
  /** Start fetching only when true (logged in + base url resolved). */
  enabled: boolean;
  /** Fetch the full candidate list (names or ids) from the server. */
  fetch: () => Promise<string[]>;
  /** Tracked (Mine) names/ids to filter the candidates down to. */
  tracked: Set<string>;
  /** Prepend the NONE_OPTION sentinel. Default true. */
  includeNone?: boolean;
}

/**
 * Returns the dropdown options: the tracked subset of the fetched list,
 * optionally prefixed with "(none)". Recomputed when `tracked` changes; the
 * underlying fetch runs once per `enabled` transition.
 */
export function useMineOptions(params: MineOptionsParams): string[] {
  const { enabled, fetch, tracked, includeNone = true } = params;
  const [all, setAll] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const names = await fetch();
        if (!cancelled) setAll(names);
      } catch {
        if (!cancelled) setAll([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // fetch is a fresh closure each render; key the fetch off `enabled` only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const mine = all.filter((n) => tracked.has(n));
  return includeNone ? [NONE_OPTION, ...mine] : mine;
}
