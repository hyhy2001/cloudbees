/**
 * Controller plugin — select and manage CloudBees controllers.
 */

import type { Plugin, PluginContext, TuiScreen } from "../../registry/types";
import { registerControllerCommands } from "./commands";
import { controllerScreen } from "./screen";

export const controllerPlugin: Plugin = {
  meta: {
    name: "controller",
    description: "Select and manage CloudBees controllers",
    version: "1.0.0",
    category: "command",
  },
  register(ctx: PluginContext): void {
    registerControllerCommands(ctx);
  },
  screen(): TuiScreen {
    return controllerScreen();
  },
};
