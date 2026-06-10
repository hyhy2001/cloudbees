/**
 * Settings TUI tab — system info panel with cache-clear action.
 *
 * Uses the OC-level client (useController: false) for health + version.
 * No DataTable — just an info panel with key bindings.
 */

import React, { useCallback } from "react";
import { Box, Text, useInput } from "ink";
import type { FC } from "react";
import type { TuiScreen, TuiScreenProps } from "../../registry/types";
import { SYM, borderStyle } from "../../core/tui/symbols";
import { THEME } from "../../core/tui/theme";
import { Spinner } from "../../core/tui/components/Spinner";
import { useResource } from "../../core/tui/data/use-resource";
import { clearAll } from "../../core/cache/manager";
import { healthCheck, getVersion } from "./service";
import type { SystemHealth } from "./service";

// Replicate the build-time version guard from main.ts
declare const BEE_VERSION: string | undefined;
const CLI_VERSION = typeof BEE_VERSION !== "undefined" ? BEE_VERSION : "0.3.0";

interface SystemInfo {
  version: string;
  health: SystemHealth;
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
      const [version, health] = await Promise.all([
        getVersion(client),
        healthCheck(client),
      ]);
      return { version, health };
    },
    { ttlMs: 30_000, enabled: ctx.loggedIn },
  );

  const doClearCache = useCallback(async () => {
    try {
      clearAll(ctx.dbPath);
      ctx.notify("Cache cleared", "success");
      void refetch();
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [ctx, refetch]);

  useInput(
    (input) => {
      switch (input) {
        case "c":
          void doClearCache();
          break;
        case "R":
          void refetch();
          break;
        default:
          break;
      }
    },
    { isActive: active },
  );

  const notLoggedIn = !ctx.loggedIn;
  const errMsg = error ? error.message : "";

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Header */}
      <Text>
        {" "}
        {SYM.gear} Settings{"  "}
        <Text color={THEME.dim}>c=clear cache · R=refresh</Text>
      </Text>
      <Text>
        {" "}
        {SYM.arrow} System info
        {status === "stale" ? <Text color={THEME.dim}> · refreshing…</Text> : null}
      </Text>

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
        </Box>
      )}
    </Box>
  );
};

/** The plugin's TUI screen descriptor. */
export function systemScreen(): TuiScreen {
  return {
    id: "settings",
    title: "Settings",
    order: 6,
    icon: SYM.gear,
    Component: SettingsScreen,
  };
}
