/**
 * Databricks OAuth M2M provider for `bee ask`.
 *
 * Handles all three clouds (AWS, Azure, GCP) using the same discovery
 * approach as the official Python Databricks SDK:
 *
 *   OIDC discovery:  GET {host}/oidc/.well-known/oauth-authorization-server
 *   Azure discovery: GET {host}/oidc/oauth2/v2.0/authorize → follow 302 redirect
 *   Token (AWS/GCP): POST {host}/oidc/v1/token with Basic Auth
 *   Token (Azure):   POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
 *   Serving:         POST {host}/serving-endpoints/{model}/invocations
 */
import { SYSTEM_PROMPT } from "../context";

interface TokenCache {
  token: string;
  expiresAt: number;
}

interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export class DatabricksOAuthProvider {
  public readonly name = "databricks-oauth";

  private host: string;
  private clientId: string;
  private clientSecret: string;
  private model: string;
  private azure: boolean;
  private tokenEndpoint = "";
  private cache: TokenCache | null = null;

  public constructor(host: string, clientId: string, clientSecret: string, model: string) {
    this.host = host.replace(/\/$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.model = model;
    this.azure = /azuredatabricks|azure/i.test(host);
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
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[docs] Databricks OAuth validation failed: ${msg}\n`);
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
    if (this.azure) return this.fetchAzureToken();
    return this.fetchAwsGcpToken();
  }

  /** AWS & GCP: discover OIDC endpoints, then POST {tokenEndpoint} with Basic Auth. */
  private async fetchAwsGcpToken(): Promise<string> {
    const endpoints = await this.discoverOidcEndpoints();
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");

    const resp = await fetch(endpoints.tokenEndpoint, {
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
   * Azure: discover Azure AD endpoints by following the OAuth2 redirect,
   * then POST to Azure AD for a token.
   */
  private async fetchAzureToken(): Promise<string> {
    const endpoints = await this.discoverAzureEndpoints();

    const appId = "2ff814a6-3304-4ab8-85cb-cd0e6f879c1d";
    const scope = `${appId}/.default`;

    const resp = await fetch(endpoints.tokenEndpoint, {
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

  /**
   * Discover OIDC endpoints via the Databricks OIDC metadata endpoint
   * (same approach as the Python SDK).
   */
  private async discoverOidcEndpoints(): Promise<OidcEndpoints> {
    // First try /.well-known/databricks-config for cloud & OIDC info
    try {
      const r = await fetch(`${this.host}/.well-known/databricks-config`, {
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const meta = (await r.json()) as { oidc_endpoint?: string };
        if (meta.oidc_endpoint) {
          const ep = await fetch(meta.oidc_endpoint, { signal: AbortSignal.timeout(5000) });
          if (ep.ok) {
            const oidc = (await ep.json()) as { authorization_endpoint?: string; token_endpoint?: string };
            if (oidc.token_endpoint) {
              return { authorizationEndpoint: oidc.authorization_endpoint ?? "", tokenEndpoint: oidc.token_endpoint };
            }
          }
        }
      }
    } catch { /* fall through */ }

    // Fall back to the standard workspace OIDC endpoint
    const url = `${this.host}/oidc/.well-known/oauth-authorization-server`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      throw new Error(`OIDC discovery failed (HTTP ${resp.status}) at ${url}`);
    }
    const data = (await resp.json()) as { authorization_endpoint?: string; token_endpoint?: string };
    const tokenEndpoint = data.token_endpoint;
    if (!tokenEndpoint) throw new Error("OIDC metadata missing token_endpoint");
    return { authorizationEndpoint: data.authorization_endpoint ?? "", tokenEndpoint };
  }

  /**
   * Azure: discover AD endpoints by following the OAuth2 redirect to Azure AD,
   * then check DATABRICKS_AZURE_TENANT_ID if the redirect fails.
   *
   * IMPORTANT: do NOT call discoverOidcEndpoints() here — for Azure workspaces
   * the OIDC endpoint returns a Databricks-hosted OIDC URL that expects
   * Basic Auth, conflicting with the Azure AD client_credentials flow which
   * sends credentials in the request body.
   */
  private async discoverAzureEndpoints(): Promise<OidcEndpoints> {
    // Try Azure redirect: GET /oidc/oauth2/v2.0/authorize, follow 302
    // to get the Azure AD endpoint (same as Python SDK's
    // get_azure_entra_id_workspace_endpoints).
    try {
      const resp = await fetch(`${this.host}/oidc/oauth2/v2.0/authorize`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
      const location = resp.headers.get("location");
      if (location) {
        // Location is an Azure AD URL like:
        // https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize?...
        const tokenEndpoint = location.replace("/authorize", "/token").split("?")[0]!;
        return { authorizationEndpoint: location.split("?")[0]!, tokenEndpoint };
      }
    } catch { /* fall through */ }

    // Fall back to DATABRICKS_AZURE_TENANT_ID env var
    const tenant = process.env["DATABRICKS_AZURE_TENANT_ID"] ?? "";
    if (tenant) {
      return {
        authorizationEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
        tokenEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      };
    }
    throw new Error(
      "Azure AD endpoint discovery failed. " +
      "Set DATABRICKS_AZURE_TENANT_ID env var with your Azure tenant ID.",
    );
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

/** True when the host looks like a Databricks workspace. */
export function isDatabricksHost(host: string): boolean {
  return /databricks|cloud\.databricks/i.test(host) || !!process.env["DATABRICKS_AZURE_TENANT_ID"];
}
