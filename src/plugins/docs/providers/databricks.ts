/**
 * Databricks OAuth M2M provider for `bee ask`.
 *
 * Handles all three clouds (AWS, Azure, GCP) without external SDK.
 *
 * Flow:
 *   1. Detect cloud from workspace URL.
 *   2. AWS/GCP → POST {workspace}/oidc/v1/token with Basic Auth.
 *   3. Azure → GET {workspace}/api/2.0/oidc/well-known for tenant metadata,
 *      then POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token.
 *   4. Cache the access token (per-process, with expiry safety margin).
 *   5. Call {workspace}/serving-endpoints/{model}/invocations on each generate().
 */
import { SYSTEM_PROMPT } from "../context";

type Cloud = "aws" | "azure" | "gcp";

interface TokenCache {
  token: string;
  expiresAt: number;
}

export class DatabricksOAuthProvider {
  public readonly name = "databricks-oauth";

  private host: string;
  private clientId: string;
  private clientSecret: string;
  private model: string;
  private cloud: Cloud;
  private cache: TokenCache | null = null;

  public constructor(host: string, clientId: string, clientSecret: string, model: string) {
    this.host = host.replace(/\/$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.model = model;
    this.cloud = detectCloud(host);
  }

  async generate(prompt: string): Promise<string> {
    const token = await this.getToken();
    const url = `${this.host}/serving-endpoints/${encodeURIComponent(this.model)}/invocations`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        max_tokens: 256,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Databricks LM error (HTTP ${response.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content?.trim() ?? "";
  }

  /** Verify credentials by attempting a token exchange. */
  async validate(): Promise<boolean> {
    try {
      await this.getToken();
      return true;
    } catch (err) {
      process.stderr.write(`[docs] Databricks OAuth validation failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return false;
    }
  }

  // ── Token management ────────────────────────────────────────────────────

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.token;
    return this.fetchToken();
  }

  private async fetchToken(): Promise<string> {
    if (this.cloud === "azure") return this.fetchAzureToken();
    return this.fetchAwsGcpToken();
  }

  /** AWS & GCP: POST {host}/oidc/v1/token with Basic Auth. */
  private async fetchAwsGcpToken(): Promise<string> {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const resp = await fetch(`${this.host}/oidc/v1/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "all-apis",
      }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    return this.parseTokenResponse(resp);
  }

  /**
   * Azure: fetch OIDC metadata to discover the tenant & token endpoint, then
   * exchange credentials via Azure AD.
   *
   * The well-known endpoint may not be available on all workspaces — when it
   * 404s we fall back to the AZURE_TENANT_ID from env (set by the user).
   * The Databricks resource app ID (scope) is a well-known constant:
   *   2ff814a6-3304-4ab8-85cb-cd0e6f879c1d
   * (Databricks Azure Enterprise Application client ID, documented by Databricks).
   */
  private async fetchAzureToken(): Promise<string> {
    // 1. Try to discover tenant from OIDC metadata (two possible endpoints)
    let tenant = "";
    let tokenEndpoint = "";

    for (const path of ["/api/2.0/oidc/well-known", "/oidc/v1/well-known"]) {
      try {
        const r = await fetch(`${this.host}${path}`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const meta = (await r.json()) as { tenant_id?: string; token_endpoint?: string };
          if (meta.tenant_id) tenant = meta.tenant_id;
          if (meta.token_endpoint) tokenEndpoint = meta.token_endpoint;
          if (tenant) break;
        }
      } catch { /* try next */ }
    }

    // 2. Fall back to DATABRICKS_AZURE_TENANT_ID env var
    if (!tenant) {
      tenant = process.env["DATABRICKS_AZURE_TENANT_ID"] ?? "";
    }

    // 3. Exchange credentials via Azure AD
    const appId = "2ff814a6-3304-4ab8-85cb-cd0e6f879c1d";
    const scope = `${appId}/.default`;
    // Use the discovered tenant or 'organizations' which auto-routes based on
    // the client ID (no tenant ID required from the user).
    const tenantId = tenant || "organizations";
    const tokenUrl = tokenEndpoint || `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope,
      }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    return this.parseTokenResponse(resp);
  }

  private async parseTokenResponse(resp: Response): Promise<string> {
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Databricks OAuth failed (HTTP ${resp.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const json = (await resp.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    const token = json.access_token;
    if (!token) throw new Error("Databricks OAuth: no access_token in response");

    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    this.cache = { token, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
    return token;
  }
}

// ── Cloud detection ─────────────────────────────────────────────────────────

function detectCloud(host: string): Cloud {
  const h = host.toLowerCase();
  if (h.includes("azuredatabricks") || h.includes("azure")) return "azure";
  if (h.includes("gcp") || h.includes("google")) return "gcp";
  return "aws";
}

// Exported for index.ts to check whether we should attempt OAuth at all.
export function isDatabricksHost(host: string): boolean {
  return /databricks|cloud\.databricks/i.test(host) || !!process.env["DATABRICKS_AZURE_TENANT_ID"];
}
