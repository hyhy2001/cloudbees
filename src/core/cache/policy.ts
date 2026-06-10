/**
 * Cache TTL policy constants (seconds) per resource type.
 * 1:1 port of legacy/cb/cache/policy.py
 */

const TTL: Record<string, number> = {
  "jobs.list":                10,
  "jobs.detail":              10,
  "controllers.list":         10,
  "controllers.detail":       10,
  "controllers.capabilities": 10,
  "credentials.list":         10,
  "credentials.detail":       10,
  "nodes.list":               10,
  "nodes.detail":             10,
};

const DEFAULT_TTL = 10;

/**
 * Return TTL (seconds) for a given resource key.
 * Does a prefix match over the TTL map, falling back to DEFAULT_TTL.
 */
export function getTtl(key: string): number {
  for (const [prefix, ttl] of Object.entries(TTL)) {
    if (key.startsWith(prefix)) return ttl;
  }
  return DEFAULT_TTL;
}
