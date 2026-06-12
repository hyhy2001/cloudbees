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
  getNode,
  createPermanentNode,
  updateNode,
  deleteNode,
  toggleOffline,
  parseNodeConfig,
} from "./service";
import { listCredentials } from "../credential/service";
import { useMineOptions, NONE_OPTION } from "../../core/tui/data/use-mine-options";
import { useDimensions } from "../../core/tui/data/use-dimensions";
import { getScopeShowAll, setScopeShowAll } from "../../core/db/repositories/scope-repo";
import {
  getTrackedResources,
  trackResource,
  untrackResource,
} from "../../core/db/repositories/resource-repo";

// ─── Nodes screen ─────────────────────────────────────────────────────────────

const NodesScreen: FC<TuiScreenProps> = ({ ctx, active }) => {
  const [showAll, setShowAll] = useState(() => getScopeShowAll("node", ctx.dbPath));
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const { columns: termCols } = useDimensions();

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
    return new Set(getTrackedResources("node", ctx.profile, baseUrl, ctx.dbPath));
  }, [baseUrl, ctx.dbPath, ctx.profile, allNodes]);

  // Tracked credential IDs (system store) — for the SSH credential dropdown.
  const trackedCreds = useMemo(() => {
    if (!baseUrl) return new Set<string>();
    return new Set(getTrackedResources("credential", ctx.profile, `${baseUrl}.system`, ctx.dbPath));
  }, [baseUrl, ctx.dbPath, ctx.profile]);

  // Credential picker options (Mine credentials in the system store), prefetched.
  const credentialOptions = useMineOptions({
    enabled: ctx.loggedIn && baseUrl !== null,
    fetch: async () => {
      const client = await ctx.getClient({ useController: true });
      const creds = await listCredentials(client, ctx.username, "system");
      return creds.map((c) => c.id);
    },
    tracked: trackedCreds,
  });

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
            { name: "name", label: "Node Name", required: true, hint: "node name" },
            { name: "remoteDir", label: "Remote Dir", required: true, path: true, hint: "Tab completes local FS" },
            { name: "numExecutors", label: "Executors", initial: "1", hint: "e.g. 1" },
            { name: "labels", label: "Labels", hint: "space-separated" },
            { name: "desc", label: "Description", hint: "optional" },
            { name: "launcher", label: "Launch method", options: ["ssh", "jnlp"], initial: "ssh" },
            { name: "host", label: "SSH Host", placeholder: "ssh only", hint: "ssh host/IP" },
            { name: "port", label: "SSH Port", placeholder: "ssh only (default 22)", hint: "default 22" },
            { name: "credentialsId", label: "SSH Credential", options: credentialOptions.length > 0 ? credentialOptions : [NONE_OPTION] },
            { name: "availability", label: "Availability", options: ["always", "demand"], initial: "always" },
            { name: "inDemandDelay", label: "In-demand Delay", initial: "0", hint: "minutes" },
            { name: "idleDelay", label: "Idle Delay", initial: "1", hint: "minutes" },
          ]}
          onResult={resolve}
        />
      ),
    });
    if (!result || !result.name || !result.remoteDir) return;
    try {
      const client = await ctx.getClient({ useController: true });
      const credId = result.credentialsId === NONE_OPTION ? "" : result.credentialsId;
      // JNLP launcher: the service picks JNLP when host is empty, so drop host.
      const isSsh = result.launcher !== "jnlp";
      await createPermanentNode(client, {
        name: result.name,
        remoteDir: result.remoteDir,
        numExecutors: result.numExecutors ? parseInt(result.numExecutors, 10) : 1,
        labels: result.labels ?? "",
        desc: result.desc ?? "",
        host: isSsh ? (result.host ?? "") : "",
        port: isSsh && result.port ? parseInt(result.port, 10) : undefined,
        credentialsId: isSsh ? credId || undefined : undefined,
        availability: result.availability === "demand" ? "demand" : "always",
        inDemandDelay: result.inDemandDelay ? parseInt(result.inDemandDelay, 10) : undefined,
        idleDelay: result.idleDelay ? parseInt(result.idleDelay, 10) : undefined,
      });
      trackResource("node", result.name, ctx.profile, client.baseUrl, ctx.dbPath);
      ctx.notify(`${SYM.ok} Created node: ${result.name}`, "success");
      void refetch();
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [ctx, refetch, credentialOptions]);

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
        untrackResource("node", name, ctx.profile, client.baseUrl, ctx.dbPath);
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

  // Edit = partial update of an existing node's config. The list DTO lacks
  // remoteDir, so fetch full detail first to prefill it. Fields are prefilled
  // from detail; updateNode does a partial update.
  // Edit = full partial update. Fetch detail + parse the launcher/availability
  // subtrees out of config.xml so every field is prefilled with the real value.
  // Credential is a dropdown of Mine credentials; launcher + availability are
  // cyclers; SSH/Demand sub-fields are always shown (ignored when not applicable).
  const editNode = useCallback(
    async (node: NodeDTO) => {
      const client = await ctx.getClient({ useController: true });
      let detail;
      try {
        detail = await getNode(client, node.name);
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
        return;
      }
      const cfg = parseNodeConfig(detail.configXml ?? "");
      // Prefill the credential cycler: put the current cred id first so it shows
      // as the initial value even if it isn't in the Mine list.
      const credInitial = cfg.credentialsId || NONE_OPTION;
      const baseCreds = credentialOptions.length > 0 ? credentialOptions : [NONE_OPTION];
      const credChoices = baseCreds.includes(credInitial)
        ? baseCreds
        : [credInitial, ...baseCreds];
      const result = await ctx.openModal<Record<string, string>>({
        id: "edit-node",
        render: (resolve) => (
          <FormModal
            title={`${SYM.gear} Edit Node: ${node.name}`}
            fields={[
              { name: "remoteDir", label: "Remote Dir", initial: detail.remoteDir ?? "", path: true, hint: "Tab completes local FS" },
              { name: "numExecutors", label: "Executors", initial: String(detail.numExecutors ?? 1), hint: "e.g. 1" },
              { name: "labels", label: "Labels", initial: detail.labels ?? "", hint: "space-separated" },
              { name: "desc", label: "Description", initial: detail.description ?? "", hint: "optional" },
              { name: "launcher", label: "Launch method", options: ["ssh", "jnlp"], initial: cfg.launcherType },
              { name: "host", label: "SSH Host", initial: cfg.host, hint: "ssh host/IP" },
              { name: "port", label: "SSH Port", initial: String(cfg.port), hint: "default 22" },
              { name: "credentialsId", label: "SSH Credential", options: credChoices, initial: credInitial },
              { name: "availability", label: "Availability", options: ["always", "demand"], initial: cfg.availability },
              { name: "inDemandDelay", label: "In-demand Delay", initial: String(cfg.inDemandDelay), hint: "minutes" },
              { name: "idleDelay", label: "Idle Delay", initial: String(cfg.idleDelay), hint: "minutes" },
            ]}
            onResult={resolve}
          />
        ),
      });
      if (!result) return;
      try {
        const launcherType = result.launcher === "jnlp" ? "jnlp" : "ssh";
        const credId = result.credentialsId === NONE_OPTION ? "" : result.credentialsId;
        await updateNode(client, node.name, {
          remoteDir: result.remoteDir,
          numExecutors: result.numExecutors ? parseInt(result.numExecutors, 10) : undefined,
          labels: result.labels,
          desc: result.desc,
          launcherType,
          host: result.host,
          port: result.port ? parseInt(result.port, 10) : undefined,
          credentialsId: credId,
          availability: result.availability === "demand" ? "demand" : "always",
          inDemandDelay: result.inDemandDelay ? parseInt(result.inDemandDelay, 10) : undefined,
          idleDelay: result.idleDelay ? parseInt(result.idleDelay, 10) : undefined,
        });
        ctx.notify(`${SYM.ok} Updated node: ${node.name}`, "success");
        void refetch();
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [ctx, refetch, credentialOptions],
  );

  // Import = track an existing server node into Mine (for nodes created outside bee).
  const doImport = useCallback(
    (name: string) => {
      if (!baseUrl) return;
      trackResource("node", name, ctx.profile, baseUrl, ctx.dbPath);
      ctx.notify(`${SYM.ok} Imported '${name}' into Mine`, "success");
      void refetch();
    },
    [baseUrl, ctx, refetch],
  );

  // ── Declarative keymap ────────────────────────────────────────────────────
  const hasRow = current !== undefined && current.labels !== "[DELETED_ON_SERVER]";
  // Importable = a real server row not yet in the Mine list (most useful in All view).
  const canImport = hasRow && current !== undefined && !trackedNames.has(current.name);
  // Untrackable = a row currently in the Mine list (can be removed from Mine).
  const canUntrack = hasRow && current !== undefined && trackedNames.has(current.name);
  const bindings = useMemo<KeyBinding[]>(
    () => [
      { key: "n", label: "new", run: () => void createNode() },
      { key: "e", label: "edit", when: () => hasRow, run: () => { if (current) void editNode(current); } },
      { key: "i", label: "import", when: () => canImport, run: () => { if (current) doImport(current.name); } },
      { key: "u", label: "unimport", when: () => canUntrack, run: () => { if (current) { untrackResource("node", current.name, ctx.profile, baseUrl!, ctx.dbPath); ctx.notify(`${SYM.ok} Removed '${current.name}' from Mine`, "success"); void refetch(); } } },
      { key: "d", label: "del", when: () => hasRow, run: () => { if (current) void removeNode(current.name); } },
      { key: "o", label: "toggle offline", when: () => hasRow, run: () => { if (current) void doToggleOffline(current); } },
      { key: "a", label: "mine/all", run: () => setShowAll((v) => { const nv = !v; setScopeShowAll("node", nv, ctx.dbPath); return nv; }) },
      { key: "F", label: "auto", run: () => setAutoRefresh((v) => !v) },
      search.openBinding,
      { key: "Esc", label: "clear", hidden: true, when: () => search.active, run: () => search.clear() },
      { key: "R", label: "refresh", run: () => void refetch() },
    ],
    [current, hasRow, canImport, canUntrack, baseUrl, createNode, editNode, doImport, removeNode, doToggleOffline, refetch, search],
  );
  useKeymap(bindings, { isActive: active && !search.editing });
  useEffect(() => { if (active) ctx.setActiveKeyHints(bindingsToHints(bindings)); }, [active, bindings, ctx]);

  const scope = showAll ? (
    <Text color={THEME.yellow}>ALL</Text>
  ) : (
    <Text color={THEME.success}>MINE</Text>
  );

  const notLoggedIn = !ctx.loggedIn;
  const noController = ctx.loggedIn && !ctx.activeController;
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
      ) : noController ? (
        <Box marginTop={1}>
          <Text color={THEME.warning}>
            {SYM.warn} No controller selected — open the Controllers tab and press Enter to select one
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
            tableWidth={termCols}
            columns={[
              { header: "", width: 2 },
              { header: "Status", width: 10 },
              { header: "Name", width: 36, flex: true },
              { header: "Exec", width: 6 },
              { header: "Labels", width: 28, flex: true },
              { header: "Description", width: 26, flex: true },
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
