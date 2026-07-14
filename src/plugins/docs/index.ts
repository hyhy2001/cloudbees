import type { Plugin, PluginContext } from "../../registry/types";
import { registerDocsCommands } from "./commands";
import { LM_URL, LM_API_KEY, LM_MODEL, REWRITE_MODEL, CHAT_ENDPOINT } from "./config";
import { setProvider, setRewriteProvider } from "./answer";
import { OpenAICompatProvider } from "./providers/openai";

export const docsPlugin: Plugin = {
  meta: {
    name: "docs",
    description: "Fuzzy command search (bee ask)",
    version: "1.0.0",
    category: "command",
  },
  async register(ctx: PluginContext): Promise<void> {
    // Wire the LM provider only when an endpoint is configured (baked at build
    // time or supplied via CB_LM_URL at runtime). No URL → no provider →
    // `bee ask` stays fully offline.
    //
    // The backend speaks the OpenAI API shape. Auth is a single static key
    // (CB_API_KEY) sent as Authorization: Bearer + X-Api-Key; a local
    // llama.cpp server runs unauthenticated with no key.
    if (LM_URL) {
      setProvider(new OpenAICompatProvider(CHAT_ENDPOINT, LM_API_KEY, LM_MODEL));
      if (REWRITE_MODEL !== LM_MODEL) {
        setRewriteProvider(new OpenAICompatProvider(CHAT_ENDPOINT, LM_API_KEY, REWRITE_MODEL));
      }
    }
    registerDocsCommands(ctx);
  },
};
