/**
 * Node plugin — manage CloudBees agent nodes.
 */
import type { Plugin } from "../../registry/types";
import { registerNodeCommands } from "./commands";

export const nodePlugin: Plugin = {
  meta: {
    name: "node",
    description: "Manage CloudBees agent nodes",
    version: "1.0.0",
    category: "resource",
  },
  register(ctx) {
    registerNodeCommands(ctx);
  },
};
