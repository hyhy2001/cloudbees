/**
 * Core API types — the CloudBeesClient contract.
 *
 * This interface is the seam between the HTTP client implementation (core/api/client.ts)
 * and everything that consumes it (services, plugins). Defining it separately keeps the
 * plugin contract (registry/types.ts) from depending on the concrete implementation.
 */

/** Result of a progressive (streaming) text fetch: [text, newOffset, hasMore]. */
export type ProgressiveText = [text: string, offset: number, hasMore: boolean];

/** Request body accepted by write methods (string covers our JSON/form/XML cases). */
export type RequestBody = string | Uint8Array;

/**
 * Authenticated HTTP client for a CloudBees/Jenkins endpoint.
 *
 * Mirrors the behavior of the Python CloudBeesClient (legacy/cb/api/client.py):
 * Basic-token auth, CSRF crumb injection on writes, SQLite TTL caching on GET,
 * and exponential-backoff retry on 5xx/timeout.
 */
export interface CloudBeesClient {
  /** Base URL the client targets (server root or active-controller URL). */
  readonly baseUrl: string;

  /** GET returning parsed JSON. Pass `cacheKey` to enable SQLite TTL caching. */
  get<T = unknown>(path: string, opts?: { cacheKey?: string; headers?: Record<string, string> }): Promise<T>;

  /** GET returning raw text (console logs, config.xml). No caching, no retry. */
  getText(path: string, opts?: { headers?: Record<string, string> }): Promise<string>;

  /** Progressive GET for streaming logs; reads X-Text-Size / X-More-Data headers. */
  getProgressiveText(path: string, start?: number): Promise<ProgressiveText>;

  /** POST with CSRF crumb injection. `invalidate` clears the given cache prefix on success. */
  post<T = unknown>(
    path: string,
    opts?: { body?: RequestBody; headers?: Record<string, string>; invalidate?: string },
  ): Promise<T>;

  /** POST an XML payload (config.xml for jobs/nodes/credentials), with crumb + 403 retry. */
  postXml(path: string, xml: string, opts?: { invalidate?: string }): Promise<string | null>;

  /** DELETE with CSRF crumb injection. `invalidate` clears the given cache prefix on success. */
  delete<T = unknown>(path: string, opts?: { invalidate?: string }): Promise<T>;

  /** GET without following redirects; returns the Location header for 3xx, else null. */
  resolveRedirect(path: string): Promise<string | null>;
}
