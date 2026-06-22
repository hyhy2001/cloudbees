/**
 * Databricks providers for `bee ask`.
 *
 * Three auth strategies:
 *   1. Azure CLI — runs `az account get-access-token` (no config needed)
 *   2. OAuth M2M — client_id + client_secret via Databricks OIDC endpoint
 *   3. PAT — static token (CB_API_KEY)
 */
import { SYSTEM_PROMPT } from "../context";

// ── Shared helpers ─────────────────────────────────────────────────────────

interface TokenCache {
  token: string;
  expiresAt: number;
}

const APP_ID = "2ff814a6-3304-4ab8-85cb-cd0e6f879c1d";

async function servingCall(host: string, model: string, token: string, prompt: string): Promise<string> {
  const url = `${host}/serving-endpoints/${encodeURIComponent(model)}/invocations`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
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
  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

// ── Azure CLI provider ─────────────────────────────────────────────────────

export class AzureCliProvider {
  public readonly name = "azure-cli";

  private host: string;
  private model: string;

  public constructor(host: string, model: string) {
    this.host = host.replace(/\/$/, "");
    this.model = model;
  }

  async generate(prompt: string): Promise<string> {
    const { token } = await this.getToken();
    return servingCall(this.host, this.model, token, prompt);
  }

  async validate(): Promise<boolean> {
    try {
      await this.getToken();
      return true;
    } catch (err) {
      process.stderr.write(`[docs] Azure CLI auth failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return false;
    }
  }

  private async getToken(): Promise<{ token: string; expiresAt: number }> {
    const proc = Bun.spawn(["az", "account", "get-access-token", "--resource", APP_ID, "--output", "json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const errText = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`az CLI failed (exit ${code}): ${errText.trim() || out.trim()}`);
    }
    const json = JSON.parse(out) as { accessToken: string; expiresOn: string };
    const expiresAt = Date.parse(json.expiresOn);
    return { token: json.accessToken, expiresAt: isNaN(expiresAt) ? 0 : expiresAt };
  }
}

// ── OAuth M2M provider ─────────────────────────────────────────────────────

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
    return servingCall(this.host, this.model, token, prompt);
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
    if (!this.tokenEndpoint) await this.discoverTokenEndpoint();

    // Strategy 1: Direct OIDC with Basic Auth (RFC 6749 URL-encoded)
    try {
      return await this.basicAuthExchange(this.tokenEndpoint!);
    } catch { /* try Azure AD */ }

    // Strategy 2: Azure AD via redirect discovery
    const tenants = [(await this.discoverAzureTenant()), "common"].filter(Boolean);
    for (const tenant of tenants) {
      try {
        const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: this.clientId,
            client_secret: this.clientSecret,
            scope: `${APP_ID}/.default`,
          }).toString(),
          signal: AbortSignal.timeout(10000),
        });
        return this.parseTokenResponse(r, `scope(${tenant})`);
      } catch { /* try next */ }

      try {
        const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: this.clientId,
            client_secret: this.clientSecret,
            resource: APP_ID,
          }).toString(),
          signal: AbortSignal.timeout(10000),
        });
        return this.parseTokenResponse(r, `resource(${tenant})`);
      } catch { /* try next */ }
    }

    throw new Error("Token exchange failed (401) — check credentials");
  }

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

  private async discoverAzureTenant(): Promise<string> {
    if (this.cache) return ""; // not cached means we haven't succeeded yet
    const tenant = process.env["DATABRICKS_AZURE_TENANT_ID"] ?? "";
    if (tenant) return tenant;
    for (const path of ["/aad/auth", "/oidc/v1/authorize"]) {
      try {
        const r = await fetch(`${this.host}${path}`, {
          method: "GET", redirect: "manual", signal: AbortSignal.timeout(10000),
        });
        const location = r.headers.get("location") ?? r.headers.get("Location") ?? "";
        const m = location.match(/login\.microsoftonline\.com\/([^/?]+)/);
        if (m?.[1]) return m[1];
      } catch { /* try next */ }
    }
    return "";
  }

  private async basicAuthExchange(url: string): Promise<string> {
    // Same as Python SDK's requests.HTTPBasicAuth — no URL-encoding
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
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
