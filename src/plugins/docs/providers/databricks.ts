/**
 * Databricks OAuth M2M provider for `bee ask`.
 *
 * Uses the same flow as the Python Databricks SDK for all clouds:
 *   1. Discover OIDC endpoints: GET {host}/oidc/.well-known/oauth-authorization-server
 *   2. Exchange credentials:   POST {token_endpoint} with Basic Auth
 *   3. Call serving endpoint:  POST {host}/serving-endpoints/{model}/invocations
 *
 * For Azure Databricks, the workspace OIDC endpoint acts as a proxy to Azure AD
 * — no direct Azure AD calls needed.
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
  private tokenEndpoint = "";
  private cache: TokenCache | null = null;

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

  /**
   * Same flow for all clouds (AWS, Azure, GCP):
   *   1. Discover OIDC endpoints from the workspace
   *   2. Exchange credentials via Basic Auth (per RFC 6749 §2.3.1)
   *
   * Per RFC 6749 §2.3.1, client_id and client_secret MUST be URL-encoded
   * individually before being combined into the Basic Auth value, so that
   * special characters (:, @, etc.) in the secret don't break parsing.
   */
  private async fetchToken(): Promise<string> {
    const endpoint = this.tokenEndpoint || await this.discoverTokenEndpoint();

    const encodedId = encodeURIComponent(this.clientId);
    const encodedSecret = encodeURIComponent(this.clientSecret);
    const basic = Buffer.from(`${encodedId}:${encodedSecret}`).toString("base64");

    const resp = await fetch(endpoint, {
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
   * Discover the OIDC token endpoint (same as Python SDK's
   * cfg.databricks_oidc_endpoints).
   */
  private async discoverTokenEndpoint(): Promise<string> {
    // First try /.well-known/databricks-config
    try {
      const r = await fetch(`${this.host}/.well-known/databricks-config`, {
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const meta = (await r.json()) as { oidc_endpoint?: string };
        if (meta.oidc_endpoint) {
          const ep = await fetch(meta.oidc_endpoint, { signal: AbortSignal.timeout(5000) });
          if (ep.ok) {
            const oidc = (await ep.json()) as { token_endpoint?: string };
            if (oidc.token_endpoint) {
              this.tokenEndpoint = oidc.token_endpoint;
              return oidc.token_endpoint;
            }
          }
        }
      }
    } catch { /* fall through */ }

    // Fall back to standard workspace OIDC endpoint
    const url = `${this.host}/oidc/.well-known/oauth-authorization-server`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      throw new Error(
        `OIDC discovery failed (HTTP ${resp.status}). ` +
        `Verify the workspace URL and ensure OAuth is enabled.`
      );
    }
    const data = (await resp.json()) as { token_endpoint?: string };
    const tokenEndpoint = data.token_endpoint;
    if (!tokenEndpoint) throw new Error("OIDC metadata missing token_endpoint");
    this.tokenEndpoint = tokenEndpoint;
    return tokenEndpoint;
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
  return /databricks|cloud\.databricks/i.test(host);
}
