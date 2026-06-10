/**
 * Auth plugin — authentication and profile management.
 */

import type { Plugin, PluginContext } from "../../registry/types";
import { registerAuthCommands } from "./commands";

export const authPlugin: Plugin = {
  meta: {
    name: "auth",
    description: "Authentication and profile management",
    version: "1.0.0",
    category: "command",
  },
  register(ctx: PluginContext): void {
    registerAuthCommands(ctx);
  },
};
