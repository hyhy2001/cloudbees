/**
 * Settings TUI tab — system info panel with cache-clear action.
 *
 * Uses the OC-level client (useController: false) for health + version.
 * No DataTable — just an info panel with key bindings.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import type { FC } from "react";
import type { TuiScreen, TuiScreenProps } from "../../registry/types";
import { useKeymap, bindingsToHints, type KeyBinding } from "../../core/tui/keymap";
import { SYM, borderStyle } from "../../core/tui/symbols";
import { THEME } from "../../core/tui/theme";
import { Spinner } from "../../core/tui/components/Spinner";
import { useResource } from "../../core/tui/data/use-resource";
import { clearAll } from "../../core/cache/manager";
import { healthCheck, getVersion, getInstalledPlugins } from "./service";
import type { SystemHealth, PluginInfo } from "./service";

// Replicate the build-time version guard from main.ts
declare const BEE_VERSION: string | undefined;
const CLI_VERSION = typeof BEE_VERSION !== "undefined" ? BEE_VERSION : "0.3.0";

interface SystemInfo {
  version: string;
  health: SystemHealth;
  plugins: PluginInfo[];
}

// ─── Settings screen ─────────────────────────────────────────────────────────

const SettingsScreen: FC<TuiScreenProps> = ({ ctx, active }) => {
  const cacheKey = "system.info";

  const {
    data: info,
    status,
    error,
    refetch,
    isInitialLoading,
  } = useResource<SystemInfo>(
    cacheKey,
    async () => {
      const client = await ctx.getClient({ useController: false });
      const [version, health, plugins] = await Promise.all([
        getVersion(client),
        healthCheck(client),
        getInstalledPlugins(client),
      ]);
      return { version, health, plugins };
    },
    { ttlMs: 30_000, enabled: ctx.loggedIn },
  );

  const [pluginCursor, setPluginCursor] = useState(0);

  const doClearCache = useCallback(async () => {
    try {
      clearAll(ctx.dbPath);
      ctx.notify("Cache cleared", "success");
      void refetch();
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [ctx, refetch]);

  const plugins = info?.plugins ?? [];

  const bindings = useMemo<KeyBinding[]>(
    () => [
      { key: "ctrl+x", label: "clear cache", run: () => void doClearCache() },
      { key: "r", label: "refresh", run: () => void refetch() },
      {
        key: "down",
        label: "↓",
        hidden: true,
        when: () => plugins.length > 0,
        run: () => setPluginCursor((c) => Math.min(plugins.length - 1, c + 1)),
      },
      {
        key: "up",
        label: "↑",
        hidden: true,
        when: () => plugins.length > 0,
        run: () => setPluginCursor((c) => Math.max(0, c - 1)),
      },
    ],
    [doClearCache, refetch, plugins.length],
  );
  useKeymap(bindings, { isActive: active });
  useEffect(() => { if (active) ctx.setActiveKeyHints(bindingsToHints(bindings)); }, [active, bindings, ctx]);

  const notLoggedIn = !ctx.loggedIn;
  const errMsg = error ? error.message : "";

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* ── Compact header ── */}
      <Box>
        <Text color={THEME.dim}>{SYM.gear} Info</Text>
        {status === "stale" ? <Text color={THEME.subtle}>  ⟳</Text> : null}
      </Box>

      {/* Body */}
      {isInitialLoading && ctx.loggedIn ? (
        <Box marginTop={1}>
          <Spinner label="Loading system info…" />
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {errMsg && (
            <Text color={THEME.error}>
              {SYM.fail} {errMsg}
            </Text>
          )}

          <Box flexDirection="column" borderStyle={borderStyle()} paddingX={1}>
            {/* CLI info — always available without login */}
            <Text>
              <Text color={THEME.dim}>CLI version:         </Text>
              <Text>{CLI_VERSION}</Text>
            </Text>
            <Text>
              <Text color={THEME.dim}>Active controller:   </Text>
              <Text color={ctx.activeController ? THEME.success : THEME.dim}>
                {ctx.activeController ?? "(none)"}
              </Text>
            </Text>
            <Text>
              <Text color={THEME.dim}>Logged in as:        </Text>
              <Text color={ctx.username ? THEME.normal : THEME.dim}>
                {ctx.username || "(not logged in)"}
              </Text>
            </Text>
            <Text>
              <Text color={THEME.dim}>DB path:             </Text>
              <Text color={THEME.dim}>{ctx.dbPath ?? "(default)"}</Text>
            </Text>

            {/* Server info — only when logged in and data available */}
            {notLoggedIn ? (
              <Text color={THEME.warning}>
                {SYM.warn} Not logged in — server info unavailable
              </Text>
            ) : info ? (
              <>
                <Text>
                  <Text color={THEME.dim}>Server version:      </Text>
                  <Text>{info.version}</Text>
                </Text>
                <Text>
                  <Text color={THEME.dim}>Health status:       </Text>
                  <Text
                    color={
                      info.health.status === "OK" ? THEME.success : THEME.error
                    }
                  >
                    {info.health.status}
                  </Text>
                  {info.health.message ? (
                    <Text color={THEME.dim}> — {info.health.message}</Text>
                  ) : null}
                </Text>
                {info.health.mode !== undefined ? (
                  <Text>
                    <Text color={THEME.dim}>Mode:                </Text>
                    <Text>{info.health.mode}</Text>
                  </Text>
                ) : null}
                {info.health.executors !== undefined ? (
                  <Text>
                    <Text color={THEME.dim}>Executors:           </Text>
                    <Text>{info.health.executors}</Text>
                  </Text>
                ) : null}
                {info.health.description ? (
                  <Text>
                    <Text color={THEME.dim}>Description:         </Text>
                    <Text color={THEME.dim}>{info.health.description}</Text>
                  </Text>
                ) : null}
              </>
            ) : null}
          </Box>

          {/* Plugin list */}
          {ctx.loggedIn && plugins.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text>
                {" "}
                {SYM.arrow} Plugins ({plugins.length})
              </Text>
              <Box flexDirection="column" borderStyle={borderStyle()} paddingX={1} marginTop={0}>
                {plugins.slice(Math.max(0, pluginCursor - 8), pluginCursor + 9).map((p, relIdx) => {
                  const absIdx = Math.max(0, pluginCursor - 8) + relIdx;
                  const on = absIdx === pluginCursor;
                  const statusColor = p.active ? THEME.success : THEME.dim;
                  const statusText = p.active ? "active" : p.enabled ? "enabled" : "disabled";
                  return (
                    <Box key={p.shortName}>
                      <Text color={on ? THEME.active : THEME.dim}>{on ? SYM.arrow : " "} </Text>
                      <Text color={on ? THEME.normal : THEME.dim} bold={on}>
                        {p.shortName.padEnd(36)}
                      </Text>
                      <Text color={THEME.dim}>{"  "}{p.version.padEnd(12)}{"  "}</Text>
                      <Text color={statusColor}>{statusText}</Text>
                    </Box>
                  );
                })}
              </Box>
              {plugins[pluginCursor] && (
                <Text color={THEME.dim} wrap="truncate-end">
                  {" "}{plugins[pluginCursor]!.longName}
                </Text>
              )}
            </Box>
          )}
          {ctx.loggedIn && info && plugins.length === 0 && (
            <Box marginTop={1}>
              <Text color={THEME.dim}>{SYM.warn} Plugin list requires admin/manage permissions on the Jenkins server</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};

/** The plugin's TUI screen descriptor. */
export function systemScreen(): TuiScreen {
  return {
    id: "settings",
    title: "Info",
    order: 6,
    icon: SYM.gear,
    Component: SettingsScreen,
  };
}
