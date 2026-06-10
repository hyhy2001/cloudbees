/**
 * Credential plugin — manage CloudBees credentials.
 */
import type { Plugin, PluginContext, TuiScreen } from "../../registry/types";
import { registerCredentialCommands } from "./commands";
import { credentialScreen } from "./screen";

export const credentialPlugin: Plugin = {
  meta: {
    name: "credential",
    description: "Manage CloudBees credentials",
    version: "1.0.0",
    category: "resource",
  },
  register(ctx: PluginContext): void {
    registerCredentialCommands(ctx);
  },
  screen(): TuiScreen {
    return credentialScreen();
  },
};
