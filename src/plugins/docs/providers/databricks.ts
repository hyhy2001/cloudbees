/**
 * Databricks OAuth 2.0 provider for `bee ask`, backed by the official
 * @databricks/sdk-experimental.
 *
 * Handles token exchange, caching, and renewal transparently via the SDK's
 * credential provider chain. The SDK supports OAuth M2M (client_credentials),
 * Azure AD, Google SA, and PAT — whichever the workspace requires.
 */
import { Config, WorkspaceClient, ApiError } from "@databricks/sdk-experimental";
import { SYSTEM_PROMPT } from "../context";

export class DatabricksOAuthProvider {
  public readonly name = "databricks-oauth";

  private client: WorkspaceClient;
  private config: Config;
  private model: string;

  public constructor(
    workspaceUrl: string,
    clientId: string,
    clientSecret: string,
    model: string,
  ) {
    this.model = model;
    this.config = new Config({
      host: workspaceUrl,
      clientId,
      clientSecret,
      authType: "oauth-m2m",
    });
    this.client = new WorkspaceClient(this.config);
  }

  async generate(prompt: string): Promise<string> {
    try {
      const response = await this.client.servingEndpoints.query({
        name: this.model,
        messages: [
          { role: "system" as const, content: SYSTEM_PROMPT },
          { role: "user" as const, content: prompt },
        ],
        max_tokens: 256,
        temperature: 0,
      });
      return (response as { choices?: Array<{ message?: { content?: string } }> })
        .choices?.[0]?.message?.content?.trim() ?? "";
    } catch (err) {
      if (err instanceof ApiError) {
        throw new Error(`Databricks LM error (HTTP ${err.statusCode}): ${err.message}`);
      }
      throw err;
    }
  }

  /** Verify that the OAuth credentials are valid by attempting authentication. */
  async validate(): Promise<boolean> {
    try {
      const headers = new Headers();
      await this.config.authenticate(headers);
      return headers.has("authorization");
    } catch (err) {
      const msg = err instanceof ApiError
        ? `HTTP ${err.statusCode}: ${err.message}`
        : String(err);
      process.stderr.write(`[docs] Databricks OAuth validation failed: ${msg}\n`);
      return false;
    }
  }
}
