/**
 * Plugin Registry — compile-time registration of all plugins.
 *
 * Every built-in feature (auth, controller, job, credential, node, system) is a plugin
 * registered in BUILTIN_PLUGINS below. To add a new plugin:
 *   1. Create it under src/plugins/<name>/ exporting a `plugin: Plugin`
 *   2. Import it here and add to BUILTIN_PLUGINS
 *   3. Rebuild — it is bundled into the binary (compile-time, no dynamic loading)
 */
import type { Command } from "commander";
import type { Plugin, PluginContext, OutputFormatter, GetClientOptions } from "./types";
import type { CloudBeesClient } from "../core/api/types";
import { getClient as coreGetClient } from "../core/client-factory";
import { tableFormatter, jsonFormatter } from "../core/cli/output";

import { authPlugin } from "../plugins/auth/index";
import { controllerPlugin } from "../plugins/controller/index";
import { jobPlugin } from "../plugins/job/index";
import { nodePlugin } from "../plugins/node/index";
import { credentialPlugin } from "../plugins/credential/index";
import { systemPlugin } from "../plugins/system/index";
import { foldersPlusPlugin } from "../plugins/foldersplus/index";

// Built-in plugins — populated as each is implemented.
const BUILTIN_PLUGINS: Plugin[] = [
  authPlugin,
  controllerPlugin,
  jobPlugin,
  nodePlugin,
  credentialPlugin,
  systemPlugin,
  foldersPlusPlugin,
];

/** Formatter registry (built-ins + plugin-provided). */
const formatters = new Map<string, OutputFormatter>([
  ["table", tableFormatter],
  ["json", jsonFormatter],
]);

export function registerFormatter(name: string, formatter: OutputFormatter): void {
  formatters.set(name, formatter);
}

export function getFormatter(name: string): OutputFormatter | undefined {
  return formatters.get(name);
}

/** Build the context handed to every plugin's register() hook. */
function makeContext(program: Command): PluginContext {
  return {
    program,
    async getClient(opts?: GetClientOptions): Promise<CloudBeesClient> {
      return coreGetClient(opts ?? {});
    },
    registerFormatter,
    getFormatter,
  };
}

/** Register all built-in plugins against the commander program. */
export async function initPlugins(program: Command): Promise<void> {
  const ctx = makeContext(program);
  for (const plugin of BUILTIN_PLUGINS) {
    await plugin.register(ctx);
  }
}

export { BUILTIN_PLUGINS };
export type { Plugin, PluginContext, PluginMeta, OutputFormatter } from "./types";
