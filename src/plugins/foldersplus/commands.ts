/**
 * Folders Plus CLI commands — `bee foldersplus ...`.
 * Approve-folder handshake is under `bee job controlled-agents approve`.
 */
import type { PluginContext } from "../../registry/types";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function registerFoldersPlusCommands(_ctx: PluginContext): void {
  // Commands live under `bee job controlled-agents` to keep job-related
  // operations together. This plugin contributes only the TUI screen.
}
