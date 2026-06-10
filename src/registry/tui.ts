/**
 * TUI screen collection — gathers `screen()` from every registered plugin.
 *
 * Mirrors the compile-time plugin registry (index.ts): no dynamic loading,
 * just iterate BUILTIN_PLUGINS and collect the optional TUI tabs, sorted by order.
 */

import type { TuiScreen } from "./types";
import { BUILTIN_PLUGINS } from "./index";

/** Collect all plugin-contributed TUI screens, sorted by `order` then `title`. */
export function collectScreens(): TuiScreen[] {
  const screens: TuiScreen[] = [];
  for (const plugin of BUILTIN_PLUGINS) {
    if (typeof plugin.screen === "function") {
      screens.push(plugin.screen());
    }
  }
  screens.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  return screens;
}
