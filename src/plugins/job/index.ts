/**
 * Job plugin — manage CloudBees jobs (Freestyle, Folder).
 */

import type { Plugin, PluginContext, TuiScreen } from "../../registry/types";
import { registerJobCommands } from "./commands";
import { jobScreen } from "./screen";

export const jobPlugin: Plugin = {
  meta: {
    name: "job",
    description: "Manage CloudBees jobs (Freestyle, Folder)",
    version: "1.0.0",
    category: "resource",
  },
  register(ctx: PluginContext): void {
    registerJobCommands(ctx);
  },
  screen(): TuiScreen {
    return jobScreen();
  },
};
