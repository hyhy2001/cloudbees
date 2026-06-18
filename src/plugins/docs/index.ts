import type { Plugin, PluginContext } from "../../registry/types";
import { registerDocsCommands } from "./commands";
import { LM_URL, LM_API_KEY, LM_MODEL } from "./config";
import { setProvider } from "./answer";
import { OpenAICompatProvider } from "./providers/openai";

export const docsPlugin: Plugin = {
  meta: {
    name: "docs",
    description: "Fuzzy command search (bee ask)",
    version: "1.0.0",
    category: "command",
  },
  register(ctx: PluginContext): void {
    // Wire the LM provider only when an endpoint is configured (baked at build
    // time or supplied via CB_DATABRICK_URL at runtime). No URL → no provider →
    // `bee ask` stays fully offline.
    if (LM_URL) {
      setProvider(new OpenAICompatProvider(LM_URL, LM_API_KEY, LM_MODEL));
    }
    registerDocsCommands(ctx);
  },
};
