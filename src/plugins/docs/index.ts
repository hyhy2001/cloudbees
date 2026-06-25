import type { Plugin, PluginContext } from "../../registry/types";
import { registerDocsCommands } from "./commands";
import { LM_URL, LM_API_KEY, LM_MODEL, LM_CLIENT_ID, LM_CLIENT_SECRET, CHAT_ENDPOINT } from "./config";
import { setProvider, getProvider } from "./answer";
import { OpenAICompatProvider } from "./providers/openai";
import { DatabricksOAuthProvider, isDatabricksHost } from "./providers/databricks";

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
    // Auth strategy:
    //   - If LM_URL looks like a Databricks workspace AND client credentials
    //     are present → use Databricks OAuth M2M.
    //   - Otherwise → use OpenAI-compatible provider (with API key if set,
    //     unauthenticated for local llama.cpp).
    //
    // Client credentials from env (CB_CLIENT_ID / CB_CLIENT_SECRET) may belong
    // to another tool — only attempt OAuth when the URL is clearly Databricks.
    if (LM_URL) {
      if (isDatabricksHost(LM_URL) && LM_CLIENT_ID && LM_CLIENT_SECRET) {
        const prov = new DatabricksOAuthProvider(LM_URL, LM_CLIENT_ID, LM_CLIENT_SECRET, LM_MODEL);
        if (await prov.validate()) {
          setProvider(prov);
        } else {
          process.stderr.write("[docs] WARN Databricks OAuth token exchange failed — check client_id and client_secret.\n");
        }
      }
      if (!getProvider()) {
        setProvider(new OpenAICompatProvider(CHAT_ENDPOINT || LM_URL, LM_API_KEY, LM_MODEL));
      }
    }
    registerDocsCommands(ctx);
  },
};
