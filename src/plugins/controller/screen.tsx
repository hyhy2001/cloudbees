/**
 * Controllers TUI tab — list all controllers from the OC-level client,
 * select the active one, and show an inline detail panel.
 *
 * CRITICAL: uses ctx.getClient({ useController: false }) because the
 * controller list is fetched from the Operations Center, not a controller.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import type { FC } from "react";
import type { TuiScreen, TuiScreenProps, ControllerCapabilities } from "../../registry/types";
import { useKeymap, bindingsToHints, type KeyBinding } from "../../core/tui/keymap";
import { SYM, borderStyle } from "../../core/tui/symbols";
import { THEME } from "../../core/tui/theme";
import { Spinner } from "../../core/tui/components/Spinner";
import { DataTable } from "../../core/tui/components/DataTable";
import { SearchBar } from "../../core/tui/components/SearchBar";
import { useResource } from "../../core/tui/data/use-resource";
import { computeView } from "../../core/tui/data/use-view";
import { useSearch } from "../../core/tui/data/use-search";
import { useStableCursor } from "../../core/tui/data/use-stable-cursor";
import { useDimensions } from "../../core/tui/data/use-dimensions";
import { useAutoRefresh } from "../../core/tui/data/use-auto-refresh";
import { getTtl } from "../../core/cache/policy";
import type { ControllerDTO } from "../../core/dtos/controller";
import {
  listControllers,
  resolveControllerUrl,
  selectController,
  getControllerCapabilities,
  getControllerInfo,
} from "./service";
import type { ControllerInfo } from "./service";
import { CloudBeesClientImpl } from "../../core/api/client";

// ─── Controller info overlay ─────────────────────────────────────────────────

interface InfoPanelProps {
  name: string;
  info: ControllerInfo | null;
  loading: boolean;
  capabilities: ControllerCapabilities | null;
  isActive: boolean;
}

const ControllerInfoPanel: FC<InfoPanelProps> = ({ name, info, loading, capabilities, isActive }) => {
  const CAP_ROWS: { label: string; tab: string; key: keyof ControllerCapabilities }[] = [
    { label: "Create Job", tab: "Jobs tab", key: "canCreateJob" },
    { label: "Create Node", tab: "Nodes tab", key: "canCreateNode" },
    { label: "Create Credential", tab: "Credentials tab", key: "canCreateCred" },
  ];

  return (
    <Box flexDirection="column" marginTop={1} borderStyle={borderStyle()} paddingX={1}>
      <Box>
        <Text bold color={THEME.normal}>{name}</Text>
        {isActive && <Text color={THEME.active}>{"  "}{SYM.selected} active</Text>}
        <Text color={THEME.dim}>{"  — "}Esc to close</Text>
      </Box>
      {loading && <Spinner label="Fetching info…" />}
      {info && !loading && (
        <>
          <Box marginTop={1} flexDirection="column">
            <Text color={THEME.keyhint} bold>System</Text>
            <Text color={THEME.dim}>  mode          <Text color={THEME.normal}>{info.mode || "—"}</Text></Text>
            <Text color={THEME.dim}>  description   <Text color={THEME.normal}>{info.description || "—"}</Text></Text>
            <Text color={THEME.dim}>  executors     <Text color={THEME.normal}>{info.totalExecutors} total  {info.numFreeExecutors} free</Text></Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={THEME.keyhint} bold>Current User</Text>
            <Text color={THEME.dim}>  id            <Text color={THEME.normal}>{info.userId || "—"}</Text></Text>
            <Text color={THEME.dim}>  name          <Text color={THEME.normal}>{info.userFullName || "—"}</Text></Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={THEME.keyhint} bold>Permissions</Text>
            {capabilities ? CAP_ROWS.map(({ label, tab, key }) => (
              <Box key={key}>
                <Text color={capabilities[key] ? THEME.success : THEME.error}>
                  {"  "}{capabilities[key] ? SYM.ok : SYM.fail}{"  "}
                </Text>
                <Text color={THEME.normal}>{label}</Text>
                <Text color={THEME.subtle}>{"  →  "}{tab}</Text>
              </Box>
            )) : <Text color={THEME.dim}>  —</Text>}
          </Box>
        </>
      )}
    </Box>
  );
};

// ─── Controllers screen ──────────────────────────────────────────────────────

const ControllersScreen: FC<TuiScreenProps> = ({ ctx, active }) => {
  const [autoRefresh, setAutoRefresh] = useState(false);
  const { columns: termCols } = useDimensions();
  // Info overlay state: null = closed, string = controller name being viewed.
  const [infoController, setInfoController] = useState<string | null>(null);
  const [infoData, setInfoData] = useState<ControllerInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);

  // Inline "/" search box (client-side filter; no refetch).
  const search = useSearch({ isActive: active, onEditingChange: ctx.setInputCaptured });

  // ── Read pipeline — OC-level client (useController: false) ────────────────
  const cacheKey = "controllers.list";
  const {
    data: controllers,
    status,
    error,
    refetch,
    isInitialLoading,
  } = useResource<ControllerDTO[]>(
    cacheKey,
    async () => {
      const client = await ctx.getClient({ useController: false });
      return listControllers(client);
    },
    { ttlMs: getTtl("controllers.list") * 1000, enabled: ctx.loggedIn },
  );

  useAutoRefresh({
    enabled: autoRefresh,
    active,
    refetch,
    policy: { baseMs: 5000, backoffFactor: 2, maxMs: 60000 },
  });

  // ── View pipeline: base list then "/" search filter (client-side) ──────────
  const scoped = controllers ?? [];
  const rows = useMemo(
    () =>
      computeView(scoped, {
        query: search.query,
        searchText: (c) => `${c.name} ${c.url ?? ""} ${c.description ?? ""}`,
      }),
    [scoped, search.query],
  );

  // ── Stable cursor ──────────────────────────────────────────────────────────
  const rowKeys = useMemo(() => rows.map((c) => c.name), [rows]);
  const { cursor, setCursor } = useStableCursor(rowKeys);
  const current = rows[cursor];

  // ── Actions ────────────────────────────────────────────────────────────────

  // Probe the capabilities of a controller and push into context.
  const probeCapabilities = useCallback(async (ctrlName: string) => {
    try {
      const client = await ctx.getClient({ useController: false });
      const rawToken = client instanceof CloudBeesClientImpl ? client.token : "";
      const caps = await getControllerCapabilities(client, ctrlName, rawToken);
      ctx.setCapabilities({ canCreateJob: caps.canCreateJob, canCreateNode: caps.canCreateNode, canCreateCred: caps.canCreateCred });
    } catch {
      ctx.setCapabilities(null);
    }
  }, [ctx]);

  useEffect(() => {
    if (ctx.activeController) void probeCapabilities(ctx.activeController);
    else ctx.setCapabilities(null);
  }, [ctx.activeController, probeCapabilities]);

  const doSelectController = useCallback(
    async (ctrl: ControllerDTO) => {
      try {
        const client = await ctx.getClient({ useController: false });
        const resolvedUrl = await resolveControllerUrl(client, ctrl.url);
        selectController(ctrl.name, resolvedUrl, ctx.dbPath);
        ctx.refreshController();
        ctx.notify(`${SYM.ok} Active controller: ${ctrl.name}`, "success");
        ctx.logCommand(`bee controller use ${ctrl.name}`);
        void refetch();
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [ctx, refetch],
  );

  const doViewInfo = useCallback(
    async (ctrl: ControllerDTO) => {
      setInfoController(ctrl.name);
      setInfoData(null);
      setInfoLoading(true);
      try {
        const client = await ctx.getClient({ useController: false });
        const rawToken = client instanceof CloudBeesClientImpl ? client.token : "";
        const resolvedUrl = await resolveControllerUrl(client, ctrl.url);
        const ctrlClient = new CloudBeesClientImpl(resolvedUrl, rawToken);
        const [info, caps] = await Promise.all([
          getControllerInfo(ctrlClient),
          getControllerCapabilities(client, ctrl.name, rawToken),
        ]);
        setInfoData(info);
        // Re-push capabilities in case they weren't probed yet.
        ctx.setCapabilities({ canCreateJob: caps.canCreateJob, canCreateNode: caps.canCreateNode, canCreateCred: caps.canCreateCred });
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
        setInfoController(null);
      } finally {
        setInfoLoading(false);
      }
    },
    [ctx],
  );

  // ── Declarative keymap ────────────────────────────────────────────────────
  const bindings = useMemo<KeyBinding[]>(
    () => [
      { key: "Enter", label: "info", when: () => current !== undefined && !infoController, run: () => { if (current) void doViewInfo(current); } },
      { key: "s", label: "select", when: () => current !== undefined && !infoController, run: () => { if (current) void doSelectController(current); } },
      { key: "Esc", label: "close", when: () => !!infoController, run: () => setInfoController(null) },
      { key: "F", label: "auto", hidden: !!infoController, run: () => setAutoRefresh((v) => !v) },
      search.openBinding,
      { key: "Esc", label: "clear", hidden: true, when: () => search.active && !infoController, run: () => search.clear() },
      { key: "r", label: "refresh", hidden: !!infoController, run: () => void refetch() },
    ],
    [current, doSelectController, doViewInfo, infoController, refetch, search],
  );
  useKeymap(bindings, { isActive: active && !search.editing });
  useEffect(() => { if (active) ctx.setActiveKeyHints(bindingsToHints(bindings)); }, [active, bindings, ctx]);

  const notLoggedIn = !ctx.loggedIn;
  const errMsg = error ? error.message : "";

  // Derive the short type label from the className last segment.
  function typeLabel(className: string): string {
    if (!className) return "—";
    const parts = className.split(".");
    return parts[parts.length - 1] ?? className;
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* ── Compact header ── */}
      <Box>
        <Text color={THEME.dim}>{SYM.gear} Controllers  </Text>
        {ctx.activeController
          ? <Text color={THEME.success} bold>[{ctx.activeController}]</Text>
          : <Text color={THEME.dim}>[none]</Text>}
        {autoRefresh ? <Text color={THEME.success}>  [auto]</Text> : null}
        {status === "loading" || status === "stale" ? (
          <Text color={THEME.active}>  ⟳ refreshing…</Text>
        ) : null}
      </Box>

      {/* Body */}
      {infoController ? (
        <ControllerInfoPanel
          name={infoController}
          info={infoData}
          loading={infoLoading}
          capabilities={ctx.capabilities}
          isActive={infoController === ctx.activeController}
        />
      ) : notLoggedIn ? (
        <Box marginTop={1}>
          <Text color={THEME.warning}>
            {SYM.warn} Not logged in — press Ctrl+l to login
          </Text>
        </Box>
      ) : isInitialLoading ? (
        <Box marginTop={1}>
          <Spinner label="Loading controllers…" />
        </Box>
      ) : errMsg && rows.length === 0 ? (
        <Box marginTop={1}>
          <Text color={THEME.error}>
            {SYM.fail} {errMsg}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {errMsg && (
            <Text color={THEME.error}>
              {SYM.fail} {errMsg}
            </Text>
          )}
          <SearchBar state={search} />
          <DataTable
            tableWidth={termCols}
            columns={[
              { header: " ", width: 3 },
              { header: "Name", width: 30, flex: true },
              { header: "Type", width: 18 },
              { header: "URL", width: 40, flex: true },
              { header: "Status", width: 8 },
            ]}
            rows={rows.map((c) => {
              const isActive = c.name === ctx.activeController;
              const indicator = isActive ? SYM.selected : " ";
              const statusText = c.online ? "online" : "offline";
              const statusColor = c.online ? THEME.success : THEME.warning;
              return [
                { text: indicator, color: isActive ? THEME.success : undefined },
                { text: c.name },
                { text: typeLabel(c.className).slice(0, 18), color: THEME.blue },
                { text: c.url, dim: true },
                { text: statusText, color: statusColor },
              ];
            })}
            rowKeys={rowKeys}
            cursor={cursor}
            onCursorChange={setCursor}
            active={active && !search.editing}
            emptyText="No controllers found."
          />

          {/* Detail panel */}
          {current && (
            <Box flexDirection="column" borderStyle={borderStyle()} paddingX={1} marginTop={1}>
              <Box>
                <Text bold color={THEME.normal}>{current.name}</Text>
                <Text color={THEME.dim}>{"  "}</Text>
                {current.online
                  ? <Text color={THEME.success}>{SYM.online} online</Text>
                  : <Text color={THEME.warning}>{SYM.offline} offline</Text>}
                {current.name === ctx.activeController
                  ? <Text color={THEME.active}>{`  ${SYM.selected} active`}</Text>
                  : null}
              </Box>
              <Box>
                <Text color={THEME.dim}>type </Text>
                <Text color={THEME.blue}>{typeLabel(current.className)}</Text>
              </Box>
              {current.url && (
                <Text color={THEME.subtle} wrap="truncate-end">{current.url}</Text>
              )}
              {current.description && (
                <Text color={THEME.dim} wrap="truncate-end">{current.description}</Text>
              )}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};

/** The plugin's TUI screen descriptor. */
export function controllerScreen(): TuiScreen {
  return {
    id: "controllers",
    title: "Controllers",
    order: 2,
    icon: SYM.gear,
    Component: ControllersScreen,
  };
}
