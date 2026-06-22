/**
 * Databricks OAuth M2M provider for `bee ask`.
 *
 * Tries multiple auth strategies in order:
 *   1. Direct Databricks OIDC token endpoint (Basic Auth, RFC 6749 URL-encoded)
 *   2. Azure AD v1.0 (resource param) — follows /oidc/v1/authorize redirect
 *   3. Azure AD v2.0 (scope param)
 *   4. Common tenant fallback for Azure AD
 */
import { SYSTEM_PROMPT } from "../context";

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
  private cache: TokenCache | null = null;

  // Cached discovery results
  private tokenEndpoint = "";
  private azureTenant = "";

  public constructor(host: string, clientId: string, clientSecret: string, model: string) {
    this.host = host.replace(/\/$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.model = model;
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

  async validate(): Promise<boolean> {
    try {
      await this.getToken();
      return true;
    } catch (err) {
      process.stderr.write(`[docs] Databricks OAuth: ${err instanceof Error ? err.message : String(err)}\n`);
      return false;
    }
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.token;
    return this.fetchToken();
  }

  private async fetchToken(): Promise<string> {
    // Strategy 1: Direct OIDC token endpoint with Basic Auth
    if (!this.tokenEndpoint) await this.discoverTokenEndpoint();
    try {
      return await this.doBasicAuthExchange(this.tokenEndpoint!);
    } catch { /* try next */ }

    // Strategy 2: Azure AD via redirect discovery
    const tenant = await this.discoverAzureTenant();
    if (tenant) {
      // v1.0 endpoint with resource param (Python SDK's azure_service_principal)
      const appId = "2ff814a6-3304-4ab8-85cb-cd0e6f879c1d";
      const v1Url = `https://login.microsoftonline.com/${tenant}/oauth2/token`;
      try {
        const r = await fetch(v1Url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: this.clientId,
            client_secret: this.clientSecret,
            resource: appId,
          }).toString(),
          signal: AbortSignal.timeout(10000),
        });
        return this.parseTokenResponse(r, "resource");
      } catch { /* try next */ }

      // v2.0 endpoint with scope param
      const v2Url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
      try {
        const r = await fetch(v2Url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: this.clientId,
            client_secret: this.clientSecret,
            scope: `${appId}/.default`,
          }).toString(),
          signal: AbortSignal.timeout(10000),
        });
        return this.parseTokenResponse(r, "scope");
      } catch { /* try next */ }
    }

    throw new Error("Token exchange failed (401) — check credentials");
  }

  /** Discover OIDC token endpoint from the workspace. */
  private async discoverTokenEndpoint(): Promise<void> {
    for (const path of ["/.well-known/databricks-config", "/oidc/.well-known/oauth-authorization-server"]) {
      try {
        const r = await fetch(`${this.host}${path}`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) continue;
        if (path.includes("databricks-config")) {
          const meta = (await r.json()) as { oidc_endpoint?: string };
          if (!meta.oidc_endpoint) continue;
          const ep = await fetch(meta.oidc_endpoint, { signal: AbortSignal.timeout(5000) });
          if (!ep.ok) continue;
          const oidc = (await ep.json()) as { token_endpoint?: string };
          if (oidc.token_endpoint) { this.tokenEndpoint = oidc.token_endpoint; return; }
        } else {
          const oidc = (await r.json()) as { token_endpoint?: string };
          if (oidc.token_endpoint) { this.tokenEndpoint = oidc.token_endpoint; return; }
        }
      } catch { /* try next */ }
    }
    throw new Error("OIDC discovery failed — verify workspace URL");
  }

  /** Discover Azure AD tenant by following the OAuth2 authorize redirect. */
  private async discoverAzureTenant(): Promise<string> {
    if (this.azureTenant) return this.azureTenant;
    const tenant = process.env["DATABRICKS_AZURE_TENANT_ID"] ?? "";
    if (tenant) { this.azureTenant = tenant; return tenant; }
    try {
      const r = await fetch(`${this.host}/oidc/v1/authorize`, {
        method: "GET", redirect: "manual", signal: AbortSignal.timeout(10000),
      });
      const location = r.headers.get("location");
      if (location) {
        const m = location.match(/login\.microsoftonline\.com\/([^/?]+)/);
        if (m?.[1]) { this.azureTenant = m[1]; return m[1]; }
      }
    } catch { /* fall through */ }
    return "";
  }

  /** POST to OIDC token endpoint with URL-encoded Basic Auth (RFC 6749 §2.3.1). */
  private async doBasicAuthExchange(url: string): Promise<string> {
    const encodedId = encodeURIComponent(this.clientId);
    const encodedSecret = encodeURIComponent(this.clientSecret);
    const basic = Buffer.from(`${encodedId}:${encodedSecret}`).toString("base64");
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "all-apis" }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    return this.parseTokenResponse(r, "basic");
  }

  private async parseTokenResponse(resp: Response, label = ""): Promise<string> {
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Databricks OAuth failed${label ? ` [${label}]` : ""} (HTTP ${resp.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const json = (await resp.json()) as { access_token?: string; expires_in?: number };
    const token = json.access_token;
    if (!token) throw new Error("Databricks OAuth: no access_token in response");
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    this.cache = { token, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
    return token;
  }
}

export function isDatabricksHost(host: string): boolean {
  return /databricks|cloud\.databricks/i.test(host);
}
