/**
 * Node plugin — manage CloudBees agent nodes.
 */
import type { Plugin, PluginContext, TuiScreen } from "../../registry/types";
import { registerNodeCommands } from "./commands";
import { nodeScreen } from "./screen";

export const nodePlugin: Plugin = {
  meta: {
    name: "node",
    description: "Manage CloudBees agent nodes",
    version: "1.0.0",
    category: "resource",
  },
  register(ctx: PluginContext): void {
    registerNodeCommands(ctx);
  },
  screen(): TuiScreen {
    return nodeScreen();
  },
};
