/**
 * CloudBees HTTP client — 1:1 port of legacy/cb/api/client.py
 *
 * Implements CloudBeesClient interface (types.ts) using Bun's global fetch.
 * Features: Basic-token auth, CSRF crumb injection, SQLite TTL caching,
 * exponential-backoff retry on 5xx/timeout, TLS-skip on redirect/progressive.
 */

import type { CloudBeesClient, ProgressiveText, RequestBody } from "./types";
import { APIError, AuthError, CBConnectionError, NotFoundError } from "./errors";
import { getCrumb, invalidateCrumb, type CrumbClient } from "./crumb";
import { getCached, setCache, invalidatePrefix } from "../cache/manager";
import { getTtl } from "../cache/policy";

// Retry delays in seconds — [0, 1, 2, 4] (0 = first attempt, no sleep)
const _RETRY_DELAYS = [0, 1, 2, 4] as const;

export class CloudBeesClientImpl implements CloudBeesClient, CrumbClient {
  readonly baseUrl: string;
  private readonly _token: string;
  private readonly _timeout: number;
  private readonly _dbPath: string | undefined;

  constructor(
    baseUrl: string,
    token: string,
    opts?: { timeout?: number; dbPath?: string },
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this._token = token;
    this._timeout = opts?.timeout ?? 30;
    this._dbPath = opts?.dbPath;
  }

  /** Expose the raw token for controller capability probing (controller plugin only). */
  get token(): string {
    return this._token;
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private _headers(): Record<string, string> {
    return {
      Authorization: `Basic ${this._token}`,
      Accept: "application/json",
    };
  }

  /**
   * Low-level GET used by crumb.ts — no crumb injection, no cache, full retry.
   * Exposed as public so CrumbClient interface is satisfied; the leading
   * underscore signals "internal, do not call from outside the api/ module".
   */
  async _rawGet(path: string): Promise<unknown> {
    return this._request("GET", path);
  }

  /**
   * Core request method with exponential-backoff retry.
   * Uses a total deadline budget so retries + sleeps never exceed
   * `_timeout` seconds in aggregate. Without a deadline, 4 attempts ×
   * 30 s each plus 7 s of backoff sleep = 127 s worst-case wait.
   */
  private async _request(
    method: string,
    path: string,
    opts?: {
      headers?: Record<string, string>;
      body?: RequestBody;
      signal?: AbortSignal;
    },
  ): Promise<unknown> {
    const url =
      path.startsWith("http://") || path.startsWith("https://")
        ? path
        : `${this.baseUrl}${path}`;

    const mergedHeaders: Record<string, string> = {
      ...this._headers(),
      ...(opts?.headers ?? {}),
    };

    let lastErr: Error | undefined;
    const retries = _RETRY_DELAYS.length; // 4 attempts total
    // Total deadline: the entire request (all retries + sleep) must finish
    // within _timeout seconds. Each attempt gets the remaining budget.
    const deadline = Date.now() + this._timeout * 1000;

    for (let attempt = 0; attempt < retries; attempt++) {
      const delay = _RETRY_DELAYS[attempt];
      if (delay > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break; // budget exhausted before even sleeping
        await Bun.sleep(Math.min(delay * 1000, remaining));
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break; // budget consumed by sleep

      let resp: Response;
      try {
        resp = await fetch(url, {
          method,
          headers: mergedHeaders,
          body: opts?.body,
          // Use whichever is smaller: per-attempt remaining budget or 30 s floor
          // (avoids sub-second timeouts on final retry while honoring the deadline).
          signal: AbortSignal.timeout(Math.max(5000, remaining)),
        });
      } catch (err: unknown) {
        // AbortError / TimeoutError → retry; other network errors → throw
        if (
          err instanceof Error &&
          (err.name === "AbortError" || err.name === "TimeoutError")
        ) {
          lastErr = err;
          continue;
        }
        throw new CBConnectionError(err instanceof Error ? err.message : String(err));
      }

      if (resp.status === 401) {
        throw new AuthError(401, "Invalid or expired token. Run: cb login");
      }
      if (resp.status === 403) {
        throw new AuthError(403, "Access denied (403). Check permissions or CSRF crumb.");
      }
      if (resp.status === 404) {
        throw new NotFoundError(`Resource not found: ${path}`);
      }
      if (resp.status >= 500 && attempt < retries - 1) {
        const body = await resp.text();
        lastErr = new APIError(resp.status, body.slice(0, 200));
        continue;
      }
      if (!resp.ok && resp.status !== 302 && resp.status !== 303) {
        const body = await resp.text();
        throw new APIError(resp.status, body.slice(0, 300));
      }

      // Success — parse body
      const text = await resp.text();
      if (!text) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    }

    throw lastErr ?? new APIError(0, "Request failed after retries");
  }

  /**
   * Write request (POST/DELETE) with CSRF crumb injection and 403-retry.
   * Mirrors CloudBeesClient._write_request().
   */
  private async _writeRequest(
    method: string,
    path: string,
    opts?: {
      headers?: Record<string, string>;
      body?: RequestBody;
    },
  ): Promise<unknown> {
    const crumb = await getCrumb(this);
    const crumbHeaders: Record<string, string> = crumb
      ? { [crumb.field]: crumb.value }
      : {};

    const mergedHeaders: Record<string, string> = {
      ...(opts?.headers ?? {}),
      ...crumbHeaders,
    };

    try {
      return await this._request(method, path, { ...opts, headers: mergedHeaders });
    } catch (err: unknown) {
      // 403 may mean stale crumb — invalidate and retry once
      if (err instanceof AuthError && err.statusCode === 403) {
        invalidateCrumb(this.baseUrl);
        const freshCrumb = await getCrumb(this);
        const freshHeaders: Record<string, string> = {
          ...(opts?.headers ?? {}),
          ...(freshCrumb ? { [freshCrumb.field]: freshCrumb.value } : {}),
        };
        return this._request(method, path, { ...opts, headers: freshHeaders });
      }
      throw err;
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async get<T = unknown>(
    path: string,
    opts?: { cacheKey?: string; headers?: Record<string, string> },
  ): Promise<T> {
    if (opts?.cacheKey) {
      const cached = getCached(opts.cacheKey, this._dbPath);
      if (cached !== null) return cached as T;
    }

    const data = await this._request("GET", path, { headers: opts?.headers });

    if (opts?.cacheKey && data !== null) {
      setCache(opts.cacheKey, data, getTtl(opts.cacheKey), this._dbPath);
    }

    return data as T;
  }

  async getText(
    path: string,
    opts?: { headers?: Record<string, string> },
  ): Promise<string> {
    // Delegate to _request() so getText benefits from the same 4-attempt
    // exponential backoff, 401/403/404 classification, and 5xx retry logic.
    const result = await this._request("GET", path, { headers: opts?.headers });
    return result == null ? "" : String(result);
  }

  async getProgressiveText(path: string, start = 0): Promise<ProgressiveText> {
    const base =
      path.startsWith("http://") || path.startsWith("https://")
        ? path
        : `${this.baseUrl}${path}`;

    const url = `${base}${base.includes("?") ? "&" : "?"}start=${start}`;

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "GET",
        headers: this._headers(),
        redirect: "follow",
        signal: AbortSignal.timeout(this._timeout * 1000),
      });
    } catch (err: unknown) {
      throw new CBConnectionError(err instanceof Error ? err.message : String(err));
    }

    if (resp.status === 404) return ["", start, false];

    if (!resp.ok) {
      const body = await resp.text();
      throw new APIError(resp.status, body.slice(0, 200));
    }

    const newSize = parseInt(resp.headers.get("X-Text-Size") ?? String(start), 10);
    const hasMore = (resp.headers.get("X-More-Data") ?? "false").toLowerCase() === "true";
    const text = await resp.text();
    return [text, isNaN(newSize) ? start : newSize, hasMore];
  }

  async post<T = unknown>(
    path: string,
    opts?: { body?: RequestBody; headers?: Record<string, string>; invalidate?: string },
  ): Promise<T> {
    const result = await this._writeRequest("POST", path, {
      body: opts?.body,
      headers: opts?.headers,
    });
    if (opts?.invalidate) {
      invalidatePrefix(opts.invalidate, this._dbPath);
    }
    return result as T;
  }

  async postXml(
    path: string,
    xml: string,
    opts?: { invalidate?: string },
  ): Promise<string | null> {
    // Encode as UTF-8 bytes — Jenkins requires Content-Type: text/xml;charset=UTF-8.
    // Delegate to _writeRequest so postXml gets the same 4-attempt exponential
    // backoff, 401/403/404 classification, and stale-crumb retry as post().
    const body = new TextEncoder().encode(xml);
    const result = await this._writeRequest("POST", path, {
      body,
      headers: { "Content-Type": "text/xml;charset=UTF-8" },
    });
    if (opts?.invalidate) {
      invalidatePrefix(opts.invalidate, this._dbPath);
    }
    return result == null ? null : String(result) || null;
  }

  async delete<T = unknown>(
    path: string,
    opts?: { invalidate?: string },
  ): Promise<T> {
    const result = await this._writeRequest("DELETE", path);
    if (opts?.invalidate) {
      invalidatePrefix(opts.invalidate, this._dbPath);
    }
    return result as T;
  }

  async resolveRedirect(path: string): Promise<string | null> {
    const url =
      path.startsWith("http://") || path.startsWith("https://")
        ? path
        : `${this.baseUrl}${path}`;

    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: this._headers(),
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      if ([301, 302, 303, 307, 308].includes(resp.status)) {
        return resp.headers.get("Location");
      }
    } catch {
      // Swallow errors — mirrors Python's except Exception: return None
    }
    return null;
  }

  async postRedirect(
    path: string,
    opts?: { body?: RequestBody; headers?: Record<string, string>; invalidate?: string },
  ): Promise<string | null> {
    const url =
      path.startsWith("http://") || path.startsWith("https://")
        ? path
        : `${this.baseUrl}${path}`;

    // Inject CSRF crumb the same way _writeRequest does — Jenkins rejects
    // unsafe POSTs without it. Retry once on 403 with a fresh crumb.
    const send = async (): Promise<Response> => {
      const crumb = await getCrumb(this);
      const headers: Record<string, string> = {
        ...this._headers(),
        ...(opts?.headers ?? {}),
        ...(crumb ? { [crumb.field]: crumb.value } : {}),
      };
      return fetch(url, {
        method: "POST",
        headers,
        body: opts?.body,
        redirect: "manual",
        signal: AbortSignal.timeout(this._timeout * 1000),
      });
    };

    let resp: Response;
    try {
      resp = await send();
      if (resp.status === 403) {
        invalidateCrumb(this.baseUrl);
        resp = await send();
      }
    } catch (err: unknown) {
      throw new CBConnectionError(err instanceof Error ? err.message : String(err));
    }

    if (resp.status === 401 || resp.status === 403) {
      throw new AuthError(resp.status, "Access denied — check permissions or CSRF crumb.");
    }
    // 201 Created is what Jenkins returns when a build trigger is queued (the
    // `Location` header is the queue item URL); 30x are the redirect cases used
    // by node creation. Both carry a `Location` we want to return.
    if (![201, 301, 302, 303, 307, 308].includes(resp.status)) {
      const body = await resp.text();
      throw new APIError(resp.status, body.slice(0, 300));
    }

    if (opts?.invalidate) {
      invalidatePrefix(opts.invalidate, this._dbPath);
    }
    return resp.headers.get("Location");
  }
}
