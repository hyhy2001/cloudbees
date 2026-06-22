import type { Plugin, PluginContext } from "../../registry/types";
import { registerDocsCommands } from "./commands";
import { LM_URL, LM_API_KEY, LM_MODEL, LM_CLIENT_ID, LM_CLIENT_SECRET } from "./config";
import { setProvider, getProvider } from "./answer";
import { OpenAICompatProvider } from "./providers/openai";
import { DatabricksOAuthProvider } from "./providers/databricks";

export const docsPlugin: Plugin = {
  meta: {
    name: "docs",
    description: "Fuzzy command search (bee ask)",
    version: "1.0.0",
    category: "command",
  },
  async register(ctx: PluginContext): Promise<void> {
    // Wire the LM provider only when an endpoint is configured (baked at build
    // time or supplied via CB_DATABRICK_URL at runtime). No URL → no provider →
    // `bee ask` stays fully offline.
    //
    // Auth priority:
    //   1. client_id + client_secret → Databricks OAuth M2M (exchanges for token at runtime)
    //   2. api_key                   → static Bearer token (PAT, llama-server)
    //   3. neither                   → unauthenticated local server
    if (LM_URL) {
      if (LM_CLIENT_ID && LM_CLIENT_SECRET) {
        const prov = new DatabricksOAuthProvider(LM_URL, LM_CLIENT_ID, LM_CLIENT_SECRET, LM_MODEL);
        // Validate OAuth eagerly so a stale / invalid client_id+secret surfaces
        // at plugin registration, not on the first `bee ask`. On failure fall
        // through to the API key path (or disable ask entirely).
        if (await prov.validate()) {
          setProvider(prov);
        } else {
          process.stderr.write("[docs] WARN Databricks OAuth token exchange failed — check client_id and client_secret.\n");
        }
      }
      if (!getProvider()) {
        // Always try OpenAI-compatible as fallback (works for local llama.cpp
        // with no auth, or with an API key). This keeps `bee ask` functional
        // even without OAuth credentials.
        setProvider(new OpenAICompatProvider(LM_URL, LM_API_KEY, LM_MODEL));
      }
    }
    registerDocsCommands(ctx);
  },
};
