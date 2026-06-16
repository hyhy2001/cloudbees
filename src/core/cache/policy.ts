/**
 * Cache TTL policy constants (seconds) per resource type.
 * 1:1 port of legacy/cb/cache/policy.py — TTLs extended to reduce pointless
 * refetches inside the TUI (original 10s caused network round-trips on every
 * tab switch):
 *
 *   controllers.capabilities  — 5 min  (probe POST latency is high; data rarely changes)
 *   controllers.list/detail   — 60 s   (OC controller list changes infrequently)
 *   nodes.list/detail         — 30 s   (agent status changes at human speed)
 *   credentials.list/detail   — 30 s   (cred rotation is an explicit user action)
 *   jobs.detail               — 20 s   (config rarely changes between tab switches)
 *   jobs.list                 — 15 s   (build status updates; stay reasonably fresh)
 *   jobs.exists               — 60 s   (existence check; only matters for CLI)
 */

const TTL: Record<string, number> = {
  "jobs.list":                 15,
  "jobs.queue":                 5,
  "jobs.detail":               20,
  "jobs.exists":               60,
  "controllers.list":          60,
  "controllers.detail":        60,
  "controllers.capabilities": 300,
  "credentials.list":          30,
  "credentials.detail":        30,
  "nodes.list":                30,
  "nodes.detail":              30,
  "nodes.approved":            15,
};

const DEFAULT_TTL = 15;

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
