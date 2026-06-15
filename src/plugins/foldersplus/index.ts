/**
 * Folders Plus plugin — CloudBees Folders Plus enterprise features.
 * Provides controlled-agent management and folder approval handshake.
 */
import type { Plugin, PluginContext } from "../../registry/types";
import { registerFoldersPlusCommands } from "./commands";

export const foldersPlusPlugin: Plugin = {
  meta: {
    name: "foldersplus",
    description: "CloudBees Folders Plus — controlled agents and folder approval",
    version: "1.0.0",
    category: "resource",
  },
  register(ctx: PluginContext): void {
    registerFoldersPlusCommands(ctx);
  },
};
