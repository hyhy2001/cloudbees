/**
 * Credential plugin — manage CloudBees credentials.
 */
import type { Plugin } from "../../registry/types";
import { registerCredentialCommands } from "./commands";

export const credentialPlugin: Plugin = {
  meta: {
    name: "credential",
    description: "Manage CloudBees credentials",
    version: "1.0.0",
    category: "resource",
  },
  register(ctx) {
    registerCredentialCommands(ctx);
  },
};
