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
   * Azure: first fetch OIDC metadata for the workspace to discover the tenant,
   * token endpoint, and the Databricks resource app ID (scope). Then exchange
   * credentials via Azure AD.
   *
   * The OIDC metadata endpoint returns:
   *   { tenant_id, token_endpoint, resource_app_id? }
   *
   * resource_app_id is the Azure AD App ID for Databricks (a well-known GUID).
   * If the metadata omits it, we fall back to the documented constant:
   *   2ff814a6-3304-4ab8-85cb-cd0e6f879c1d
   * (Databricks' Azure Enterprise Application client ID).
   */
  private async fetchAzureToken(): Promise<string> {
    // 1. Fetch OIDC metadata
    const metaUrl = `${this.host}/api/2.0/oidc/well-known`;
    const metaResp = await fetch(metaUrl, { signal: AbortSignal.timeout(10000) });
    if (!metaResp.ok) {
      throw new Error(`Azure OIDC metadata fetch failed (HTTP ${metaResp.status})`);
    }
    const meta = (await metaResp.json()) as {
      tenant_id?: string;
      token_endpoint?: string;
      resource_app_id?: string;
    };
    const tenant = meta.tenant_id;
    if (!tenant) throw new Error("Azure OIDC metadata missing tenant_id");

    // 2. Build scope — prefer metadata resource_app_id, fall back to constant
    const appId = meta.resource_app_id ?? "2ff814a6-3304-4ab8-85cb-cd0e6f879c1d";
    const scope = `${appId}/.default`;
    const tokenUrl = meta.token_endpoint ?? `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

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
