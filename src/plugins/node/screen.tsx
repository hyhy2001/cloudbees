/**
 * Nodes TUI tab — list, create, delete, toggle offline, Mine/All filter,
 * inline detail panel.
 *
 * Follows the exact pipeline pattern established in src/plugins/job/screen.tsx:
 *   useResource → computeView → useStableCursor → DataTable
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import type { FC } from "react";
import type { TuiScreen, TuiScreenProps } from "../../registry/types";
import { useKeymap, bindingsToHints, type KeyBinding } from "../../core/tui/keymap";
import { SYM, borderStyle } from "../../core/tui/symbols";
import { THEME } from "../../core/tui/theme";
import { Spinner } from "../../core/tui/components/Spinner";
import { DataTable } from "../../core/tui/components/DataTable";
import { SearchBar } from "../../core/tui/components/SearchBar";
import { ConfirmModal } from "../../core/tui/components/ConfirmModal";
import { FormModal } from "../../core/tui/components/FormModal";
import { useResource } from "../../core/tui/data/use-resource";
import { computeView } from "../../core/tui/data/use-view";
import { useSearch } from "../../core/tui/data/use-search";
import { useStableCursor } from "../../core/tui/data/use-stable-cursor";
import { useAutoRefresh } from "../../core/tui/data/use-auto-refresh";
import { getTtl } from "../../core/cache/policy";
import type { NodeDTO } from "../../core/dtos/node";
import {
  listNodes,
  createPermanentNode,
  deleteNode,
  toggleOffline,
} from "./service";
import {
  getTrackedResources,
  trackResource,
  untrackResource,
} from "../../core/db/repositories/resource-repo";

const PROFILE = "default";

// ─── Nodes screen ─────────────────────────────────────────────────────────────

const NodesScreen: FC<TuiScreenProps> = ({ ctx, active }) => {
  const [showAll, setShowAll] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);

  // Inline "/" search box (client-side filter; no refetch).
  const search = useSearch({ isActive: active, onEditingChange: ctx.setInputCaptured });

  // Resolve the controller base url once (cheap; client-factory caches session).
  useEffect(() => {
    let cancelled = false;
    if (!ctx.loggedIn) return;
    void (async () => {
      try {
        const client = await ctx.getClient({ useController: true });
        if (!cancelled) setBaseUrl(client.baseUrl);
      } catch {
        /* surfaced via the resource error below */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  // ── Read pipeline ──────────────────────────────────────────────────────────
  const cacheKey = `nodes.list.${baseUrl ?? "?"}`;
  const {
    data: allNodes,
    status,
    error,
    refetch,
    isInitialLoading,
  } = useResource<NodeDTO[]>(
    cacheKey,
    async () => {
      const client = await ctx.getClient({ useController: true });
      return listNodes(client);
    },
    { ttlMs: getTtl("nodes.list") * 1000, enabled: ctx.loggedIn && baseUrl !== null },
  );

  useAutoRefresh({
    enabled: autoRefresh,
    active,
    refetch,
    policy: { baseMs: 5000, backoffFactor: 2, maxMs: 60000 },
  });

  // Tracked names for Mine filter + [DELETED_ON_SERVER] synthesis.
  const trackedNames = useMemo(() => {
    if (!baseUrl) return new Set<string>();
    return new Set(getTrackedResources("node", PROFILE, baseUrl, ctx.dbPath));
  }, [baseUrl, ctx.dbPath, allNodes]);

  // ── View pipeline: Mine/All filter + synthetic deleted rows (client-side) ──
  const scoped = useMemo(() => {
    const all = allNodes ?? [];
    if (showAll) return all;
    const serverNames = new Set(all.map((n) => n.name));
    const mine = computeView(all, {
      filters: { tracked: (n: NodeDTO) => trackedNames.has(n.name) },
      activeFilters: ["tracked"],
    });
    const deleted: NodeDTO[] = [];
    for (const name of trackedNames) {
      if (!serverNames.has(name)) {
        deleted.push({
          name,
          displayName: name,
          offline: false,
          numExecutors: 0,
          labels: "[DELETED_ON_SERVER]",
          description: "",
        });
      }
    }
    return [...mine, ...deleted];
  }, [allNodes, showAll, trackedNames]);

  // Then the "/" search filter (matches name + labels + description), client-side.
  const nodes = useMemo(
    () =>
      computeView(scoped, {
        query: search.query,
        searchText: (n) => `${n.name} ${n.labels ?? ""} ${n.description ?? ""}`,
      }),
    [scoped, search.query],
  );

  // ── Stable cursor ──────────────────────────────────────────────────────────
  const rowKeys = useMemo(() => nodes.map((n) => n.name), [nodes]);
  const { cursor, setCursor } = useStableCursor(rowKeys);
  const current = nodes[cursor];

  // ── Actions ────────────────────────────────────────────────────────────────

  const createNode = useCallback(async () => {
    const result = await ctx.openModal<Record<string, string>>({
      id: "create-node",
      render: (resolve) => (
        <FormModal
          title={`${SYM.gear} Create New Node`}
          fields={[
            { name: "name", label: "Node Name", required: true },
            { name: "remoteDir", label: "Remote Dir", required: true },
            { name: "numExecutors", label: "Executors", initial: "1" },
            { name: "labels", label: "Labels" },
            { name: "desc", label: "Description" },
            { name: "host", label: "SSH Host (optional)" },
          ]}
          onResult={resolve}
        />
      ),
    });
    if (!result || !result.name || !result.remoteDir) return;
    try {
      const client = await ctx.getClient({ useController: true });
      await createPermanentNode(client, {
        name: result.name,
        remoteDir: result.remoteDir,
        numExecutors: result.numExecutors ? parseInt(result.numExecutors, 10) : 1,
        labels: result.labels ?? "",
        desc: result.desc ?? "",
        host: result.host ?? "",
      });
      trackResource("node", result.name, PROFILE, client.baseUrl, ctx.dbPath);
      ctx.notify(`${SYM.ok} Created node: ${result.name}`, "success");
      void refetch();
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [ctx, refetch]);

  const removeNode = useCallback(
    async (name: string) => {
      const ok = await ctx.openModal<boolean>({
        id: "confirm-delete-node",
        render: (resolve) => (
          <ConfirmModal
            message={`Delete node '${name}'? This cannot be undone.`}
            onResult={resolve}
          />
        ),
      });
      if (!ok) return;
      try {
        const client = await ctx.getClient({ useController: true });
        await deleteNode(client, name);
        untrackResource("node", name, PROFILE, client.baseUrl, ctx.dbPath);
        ctx.notify(`${SYM.ok} Deleted: ${name}`, "success");
        void refetch();
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [ctx, refetch],
  );

  const doToggleOffline = useCallback(
    async (node: NodeDTO) => {
      const action = node.offline ? "online" : "offline";
      const ok = await ctx.openModal<boolean>({
        id: "confirm-toggle-offline",
        render: (resolve) => (
          <ConfirmModal
            message={`Mark node '${node.name}' as ${action}?`}
            onResult={resolve}
          />
        ),
      });
      if (!ok) return;
      try {
        const client = await ctx.getClient({ useController: true });
        await toggleOffline(client, node.name);
        ctx.notify(`${SYM.ok} Marked ${action}: ${node.name}`, "success");
        void refetch();
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [ctx, refetch],
  );

  // Import = track an existing server node into Mine (for nodes created outside bee).
  const doImport = useCallback(
    (name: string) => {
      if (!baseUrl) return;
      trackResource("node", name, PROFILE, baseUrl, ctx.dbPath);
      ctx.notify(`${SYM.ok} Imported '${name}' into Mine`, "success");
      void refetch();
    },
    [baseUrl, ctx, refetch],
  );

  // ── Declarative keymap ────────────────────────────────────────────────────
  const hasRow = current !== undefined && current.labels !== "[DELETED_ON_SERVER]";
  // Importable = a real server row not yet in the Mine list (most useful in All view).
  const canImport = hasRow && current !== undefined && !trackedNames.has(current.name);
  const bindings = useMemo<KeyBinding[]>(
    () => [
      { key: "n", label: "new", run: () => void createNode() },
      { key: "i", label: "import", when: () => canImport, run: () => { if (current) doImport(current.name); } },
      { key: "d", label: "del", when: () => hasRow, run: () => { if (current) void removeNode(current.name); } },
      { key: "o", label: "toggle offline", when: () => hasRow, run: () => { if (current) void doToggleOffline(current); } },
      { key: "a", label: "mine/all", run: () => setShowAll((v) => !v) },
      { key: "F", label: "auto", run: () => setAutoRefresh((v) => !v) },
      search.openBinding,
      { key: "Esc", label: "clear", hidden: true, when: () => search.active, run: () => search.clear() },
      { key: "R", label: "refresh", run: () => void refetch() },
    ],
    [current, hasRow, canImport, createNode, doImport, removeNode, doToggleOffline, refetch, search],
  );
  useKeymap(bindings, { isActive: active && !search.editing });
  useEffect(() => { if (active) ctx.setActiveKeyHints(bindingsToHints(bindings)); }, [active, bindings, ctx]);

  const scope = showAll ? (
    <Text color={THEME.yellow}>ALL</Text>
  ) : (
    <Text color={THEME.success}>MINE</Text>
  );

  const notLoggedIn = !ctx.loggedIn;
  const errMsg = error ? error.message : "";

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Header */}
      <Text>
        {" "}
        {SYM.online} Nodes
      </Text>
      <Text>
        {" "}
        {SYM.arrow} Scope: {scope}
        {autoRefresh ? <Text color={THEME.success}> · auto ⟳</Text> : null}
        {status === "stale" ? <Text color={THEME.dim}> · refreshing…</Text> : null}
      </Text>

      {/* Body */}
      {notLoggedIn ? (
        <Box marginTop={1}>
          <Text color={THEME.warning}>
            {SYM.warn} Not logged in — press l to login
          </Text>
        </Box>
      ) : isInitialLoading ? (
        <Box marginTop={1}>
          <Spinner label="Loading nodes…" />
        </Box>
      ) : errMsg && nodes.length === 0 ? (
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
            columns={[
              { header: "", width: 2 },
              { header: "Status", width: 10 },
              { header: "Name", width: 36 },
              { header: "Exec", width: 6 },
              { header: "Labels", width: 28 },
              { header: "Description", width: 26 },
            ]}
            rows={nodes.map((n) => {
              const isDeleted = n.labels === "[DELETED_ON_SERVER]";
              const mine = trackedNames.has(n.name);
              const statusText = isDeleted
                ? "[DEL]"
                : n.offline
                ? `${SYM.offline} off`
                : `${SYM.online} on `;
              const statusColor = isDeleted
                ? THEME.error
                : n.offline
                ? THEME.warning
                : THEME.success;
              return [
                { text: mine ? SYM.tracked : "", color: THEME.success },
                { text: statusText, color: statusColor },
                { text: n.name.slice(0, 36) },
                { text: isDeleted ? "-" : String(n.numExecutors) },
                { text: isDeleted ? "[DELETED_ON_SERVER]" : n.labels.slice(0, 28), dim: isDeleted },
                { text: (n.description ?? "").slice(0, 26) },
              ];
            })}
            rowKeys={rowKeys}
            cursor={cursor}
            onCursorChange={setCursor}
            active={active && !search.editing}
            emptyText="No nodes. Press n to create one."
          />

          {/* Detail panel */}
          {current && (
            <Box flexDirection="column" borderStyle={borderStyle()} paddingX={1} marginTop={1}>
              <Text>
                <Text bold>{current.displayName || current.name}</Text>
                {"   "}
                <Text color={THEME.dim}>executors:</Text> {current.numExecutors}
                {"   "}
                <Text color={THEME.dim}>status:</Text>{" "}
                {current.offline ? (
                  <Text color={THEME.warning}>offline</Text>
                ) : (
                  <Text color={THEME.success}>online</Text>
                )}
              </Text>
              {current.labels && current.labels !== "[DELETED_ON_SERVER]" && (
                <Text color={THEME.dim} wrap="truncate-end">
                  labels: {current.labels}
                </Text>
              )}
              {current.description ? (
                <Text color={THEME.dim} wrap="truncate-end">
                  {current.description}
                </Text>
              ) : null}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};

/** The plugin's TUI screen descriptor. */
export function nodeScreen(): TuiScreen {
  return {
    id: "nodes",
    title: "Nodes",
    order: 3,
    icon: SYM.online,
    Component: NodesScreen,
  };
}
