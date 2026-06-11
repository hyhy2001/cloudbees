/**
 * useSearch — an inline "/"-to-filter search box for table screens.
 *
 *   useResource → computeView({query}) → useStableCursor → DataTable
 *                         ▲
 *                    useSearch (owns the query string + typing)
 *
 * Press `/` to enter search mode; printable chars + backspace edit the query;
 * Enter confirms (keeps the filter, leaves edit mode); Esc clears and exits.
 * The query is fed to `computeView({ query, searchText })` in the screen — a
 * pure client-side filter, no refetch (consistent with Mine/All).
 *
 * The screen wires it like this:
 *   const search = useSearch({ isActive: active && !overlay });
 *   const rows = useMemo(() => computeView(base, { query: search.query, searchText: r => r.name }), [base, search.query]);
 *   // add `search.openBinding` to the keymap; render <SearchBar state={search} />
 */

import { useState, useCallback } from "react";
import { useInput } from "ink";
import type { KeyBinding } from "../keymap";

export interface SearchState {
  /** Current query (empty string when nothing typed). */
  query: string;
  /** True while the user is actively typing the query. */
  editing: boolean;
  /** True when a query is set (whether or not still editing) — for header display. */
  active: boolean;
  /** Keymap binding that enters search mode (bind `/` in the screen keymap). */
  openBinding: KeyBinding;
  /** Clear the query and leave search mode. */
  clear: () => void;
}

export interface UseSearchOptions {
  /** Only handle typing while true (tab focused, no modal/overlay). */
  isActive: boolean;
  /** Label shown in the open-search hint. Default "search". */
  label?: string;
}

export function useSearch(opts: UseSearchOptions): SearchState {
  const { isActive, label = "search" } = opts;
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);

  const clear = useCallback(() => {
    setQuery("");
    setEditing(false);
  }, []);

  // While editing, this handler owns input: printable chars append, backspace
  // deletes, Enter confirms (keep filter), Esc clears. Gated so it only runs in
  // edit mode AND while the screen is active.
  useInput(
    (input, key) => {
      if (key.escape) {
        clear();
        return;
      }
      if (key.return) {
        setEditing(false); // confirm: keep the query, stop capturing keys
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        return;
      }
      // Ignore control chars / unprintables; accept normal text.
      if (input && !key.ctrl && !key.meta && !key.tab) {
        setQuery((q) => q + input);
      }
    },
    { isActive: isActive && editing },
  );

  const openBinding: KeyBinding = {
    key: "/",
    label,
    group: "action",
    run: () => setEditing(true),
  };

  return { query, editing, active: query.length > 0 || editing, openBinding, clear };
}
