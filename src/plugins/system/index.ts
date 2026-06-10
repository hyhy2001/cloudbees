/**
 * System plugin — system info and settings TUI tab.
 *
 * Registers NO CLI commands (system is TUI-only, matching the Python design).
 * Contributes the Settings tab via screen().
 */

import type { Plugin, PluginContext, TuiScreen } from "../../registry/types";
import { systemScreen } from "./screen";

export const systemPlugin: Plugin = {
  meta: {
    name: "system",
    description: "System info and settings",
    version: "1.0.0",
    category: "command",
  },
  register(_ctx: PluginContext): void {
    // No CLI commands — this plugin is TUI-only.
  },
  screen(): TuiScreen {
    return systemScreen();
  },
};
