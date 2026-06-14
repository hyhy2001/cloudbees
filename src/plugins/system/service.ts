/**
 * System service — health check + version.
 * Ports legacy/cb/services/system_service.py.
 *
 * NOTE: In the Python CLI this service is used ONLY by the TUI (settings/overview
 * screens), not by any `bee` command group. It is ported here ahead of the TUI
 * phase so the logic exists, but it intentionally registers NO CLI commands and
 * is NOT wired into the plugin registry yet.
 */

import type { CloudBeesClient } from "../../core/api/types";

export interface SystemHealth {
  status: string;
  mode?: string;
  description?: string;
  executors?: number;
  message?: string;
}

/** Return a dict with server health info. Mirrors Python health_check(). */
export async function healthCheck(client: CloudBeesClient): Promise<SystemHealth> {
  try {
    const data = (await client.get(
      "/api/json?tree=_class,mode,nodeDescription,numExecutors",
      { cacheKey: "system.health" },
    )) as Record<string, unknown> | null;
    return {
      status: "OK",
      mode: (data?.["mode"] as string) ?? "unknown",
      description: (data?.["nodeDescription"] as string) ?? "",
      executors: (data?.["numExecutors"] as number) ?? 0,
    };
  } catch (err) {
    return { status: "ERROR", message: err instanceof Error ? err.message : String(err) };
  }
}

export interface PluginInfo {
  shortName: string;
  longName: string;
  version: string;
  active: boolean;
  enabled: boolean;
}

/**
 * Fetch installed plugins from /pluginManager/api/json.
 * Returns empty array on 403 (insufficient permissions) or any error.
 */
export async function getInstalledPlugins(client: CloudBeesClient): Promise<PluginInfo[]> {
  try {
    const data = (await client.get(
      "/pluginManager/api/json?tree=plugins[shortName,longName,version,active,enabled]",
      { cacheKey: "system.plugins" },
    )) as Record<string, unknown> | null;
    const raw = (data?.["plugins"] as unknown[]) ?? [];
    return raw.map((p) => {
      const r = p as Record<string, unknown>;
      return {
        shortName: String(r["shortName"] ?? ""),
        longName: String(r["longName"] ?? ""),
        version: String(r["version"] ?? ""),
        active: Boolean(r["active"]),
        enabled: Boolean(r["enabled"]),
      };
    });
  } catch {
    return [];
  }
}

/**
 * Check if a specific plugin is installed and active.
 * Fails open (returns true) on permission errors — caller should not block UX
 * if we can't verify.
 */
export async function hasPlugin(client: CloudBeesClient, shortName: string): Promise<boolean> {
  const plugins = await getInstalledPlugins(client);
  // Empty list could mean 403/error (fail-open) or genuinely no plugins.
  // We treat empty as unknown → true to avoid false negatives.
  if (plugins.length === 0) return true;
  return plugins.some((p) => p.shortName === shortName && p.active);
}

/** Return CloudBees server version string. Mirrors Python get_version(). */
export async function getVersion(client: CloudBeesClient): Promise<string> {
  try {
    const data = (await client.get("/api/json?tree=_class", {
      cacheKey: "system.version",
    })) as Record<string, unknown> | null;
    return String(data?.["_class"] ?? "unknown");
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
