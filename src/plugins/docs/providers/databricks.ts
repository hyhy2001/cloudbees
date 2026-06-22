/**
 * Databricks provider using the official @databricks/sdk-experimental.
 *
 * The SDK supports multiple auth methods (OAuth M2M, Azure CLI, managed
 * identity, PAT) and auto-discovers the Azure AD tenant when possible.
 * We let the SDK handle auth — it knows which credentials to use and how
 * to exchange them for each cloud (AWS, Azure, GCP).
 */
import { Config, WorkspaceClient, ApiError } from "@databricks/sdk-experimental";
import { SYSTEM_PROMPT } from "../context";

export class DatabricksOAuthProvider {
  public readonly name = "databricks-oauth";

  private client: WorkspaceClient;
  private config: Config;
  private model: string;

  public constructor(host: string, clientId: string, clientSecret: string, model: string) {
    this.model = model;
    this.config = new Config({
      host,
      clientId,
      clientSecret,
      // Azure AD single-tenant apps require a tenant ID. The SDK tries to
      // discover it from env (DATABRICKS_AZURE_TENANT_ID), Azure CLI, or
      // managed identity. Do NOT force authType — let the SDK's credential
      // provider chain try every method.
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

  /** Verify credentials by attempting authentication. */
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

/** True when the host looks like a Databricks workspace. */
export function isDatabricksHost(host: string): boolean {
  return /databricks|cloud\.databricks/i.test(host) || !!process.env["DATABRICKS_AZURE_TENANT_ID"];
}
