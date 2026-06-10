/**
 * CSRF crumb fetcher — 1:1 port of legacy/cb/api/crumb.py
 *
 * Module-level Map cache keyed by baseUrl, 5-minute TTL.
 */

/** Shape returned by getCrumb and stored in cache. */
export interface CrumbData {
  field: string;
  value: string;
}

interface CrumbCacheEntry {
  crumb: CrumbData;
  expiresAt: number; // ms since epoch
}

/** Internal interface the crumb module needs from the client. */
export interface CrumbClient {
  readonly baseUrl: string;
  /** Low-level unauthenticated-crumb-free GET used only by crumb.ts. */
  _rawGet(path: string): Promise<unknown>;
}

const _crumbCache = new Map<string, CrumbCacheEntry>();
const CRUMB_TTL_MS = 300 * 1000; // 5 minutes in milliseconds

/**
 * Fetch (or return cached) CSRF crumb for this CloudBees server.
 * Returns { field, value } or null if server has CSRF disabled.
 */
export async function getCrumb(client: CrumbClient): Promise<CrumbData | null> {
  const key = client.baseUrl;
  const entry = _crumbCache.get(key);
  if (entry && Date.now() < entry.expiresAt) {
    return entry.crumb;
  }

  try {
    const data = await client._rawGet("/crumbIssuer/api/json");
    if (
      data !== null &&
      typeof data === "object" &&
      "crumb" in data &&
      typeof (data as Record<string, unknown>)["crumb"] === "string"
    ) {
      const rec = data as Record<string, unknown>;
      const crumb: CrumbData = {
        field:
          typeof rec["crumbRequestField"] === "string"
            ? rec["crumbRequestField"]
            : "Jenkins-Crumb",
        value: rec["crumb"] as string,
      };
      _crumbCache.set(key, { crumb, expiresAt: Date.now() + CRUMB_TTL_MS });
      return crumb;
    }
  } catch {
    // Server may not have CSRF protection enabled — return null
  }
  return null;
}

/** Remove cached crumb for a server (call after 403 response). */
export function invalidateCrumb(baseUrl: string): void {
  _crumbCache.delete(baseUrl);
}
