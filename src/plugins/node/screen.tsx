/**
 * Nodes TUI tab — list, create, delete, toggle offline, Mine/All filter,
 * inline detail panel.
 *
 * Follows the exact pipeline pattern established in src/plugins/job/screen.tsx:
 *   useResource → computeView → useStableCursor → DataTable
 */

import os from "node:os";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ContextMenu } from "../../core/tui/components/ContextMenu";
import { GrantListOverlay, type GrantItem } from "../../core/tui/components/GrantListOverlay";
import { useResource } from "../../core/tui/data/use-resource";
import { computeView } from "../../core/tui/data/use-view";
import { useSearch } from "../../core/tui/data/use-search";
import { useStableCursor } from "../../core/tui/data/use-stable-cursor";
import { useAutoRefresh } from "../../core/tui/data/use-auto-refresh";
import { getTtl } from "../../core/cache/policy";
import type { NodeDTO } from "../../core/dtos/node";
import type { NodeConfig } from "./service";
import {
  listNodes,
  getNode,
  createPermanentNode,
  updateNode,
  deleteNode,
  toggleOffline,
  parseNodeConfig,
  listApprovedFolders,
  deleteAgentToken,
} from "./service";
import { approveFolder } from "../foldersplus/service";
import { listJobsRecursive } from "../job/service";
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

// First non-internal IPv4 of the machine running the CLI — a sane default for
// the SSH Host field (correct only when the CLI runs on the agent itself; the
// user can still edit it).
function detectLocalHost(): string {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "";
}

const NodesScreen: FC<TuiScreenProps> = ({ ctx, active }) => {
  const [showAll, setShowAll] = useState(() => getScopeShowAll("node", ctx.dbPath));
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [nodeConfig, setNodeConfig] = useState<NodeConfig | null>(null);
  const configCache = useRef<Map<string, NodeConfig>>(new Map());
  const { columns: termCols } = useDimensions();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Approved-folders overlay: the agent whose grants are being viewed (null = closed).
  const [foldersAgent, setFoldersAgent] = useState<string | null>(null);
  // Items fetched for the overlay — null = loading.
  const [approvedFolderItems, setApprovedFolderItems] = useState<GrantItem[] | null>(null);

  // Fetch approved folders whenever the overlay opens or is refreshed.
  const fetchApprovedFolders = useCallback(async (agentName: string) => {
    setApprovedFolderItems(null);
    try {
      const client = await ctx.getClient({ useController: true });
      const grants = await listApprovedFolders(client, agentName);
      setApprovedFolderItems(
        grants.map((g) => ({
          label: g.folderName ?? "",
          id: g.tokenId,
          pending: g.folderName === null,
        })),
      );
    } catch {
      setApprovedFolderItems([]);
    }
  }, [ctx]);

  useEffect(() => {
    if (foldersAgent) void fetchApprovedFolders(foldersAgent);
    else setApprovedFolderItems(null);
  }, [foldersAgent, fetchApprovedFolders]);

  // Inline "/" search box (client-side filter; no refetch). Suspended while the
  // approved-folders overlay is open.
  const search = useSearch({ isActive: active && foldersAgent === null, onEditingChange: ctx.setInputCaptured });

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

  // Fetch and cache NodeConfig for the detail panel (best-effort, non-blocking).
  useEffect(() => {
    if (!current) { setNodeConfig(null); return; }
    const cached = configCache.current.get(current.name);
    if (cached) { setNodeConfig(cached); return; }
    void (async () => {
      try {
        const client = await ctx.getClient({ useController: true });
        const detail = await getNode(client, current.name);
        const cfg = parseNodeConfig(detail.configXml ?? "");
        configCache.current.set(current.name, cfg);
        setNodeConfig(cfg);
      } catch {
        /* best-effort; detail panel falls back gracefully */
      }
    })();
  }, [current?.name, ctx]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const createNode = useCallback(async () => {
    const result = await ctx.openModal<Record<string, string>>({
        id: "create-node",
        render: (resolve) => (
          <FormModal
            title={`${SYM.gear} Create New Node`}
            fields={[
              { name: "name", label: "Node Name", required: true, hint: "unique id" },
              { name: "remoteDir", label: "Remote Dir", required: true, path: true, hint: "Tab completes local FS" },
              { name: "numExecutors", label: "Executors", initial: "1", hint: "e.g. 1" },
              { name: "labels", label: "Labels", hint: "space-separated" },
              { name: "desc", label: "Description", hint: "optional" },
              { name: "launcher", label: "Launch method", options: ["ssh", "jnlp"], initial: "ssh" },
              { name: "host", label: "SSH Host", initial: detectLocalHost(), hint: "hostname or IP (auto-detected, editable)", visible: (v) => v["launcher"] !== "jnlp" },
              { name: "port", label: "SSH Port", placeholder: "22", hint: "default 22", visible: (v) => v["launcher"] !== "jnlp" },
              { name: "credentialsId", label: "SSH Credential", options: credentialOptions.length > 0 ? credentialOptions : [NONE_OPTION], searchable: true, visible: (v) => v["launcher"] !== "jnlp" },
              { name: "availability", label: "Availability", options: ["always", "demand"], initial: "always" },
              { name: "inDemandDelay", label: "In-demand Delay", initial: "0", hint: "minutes", visible: (v) => v["availability"] === "demand" },
              { name: "idleDelay", label: "Idle Delay", initial: "1", hint: "minutes", visible: (v) => v["availability"] === "demand" },
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
      if (isSsh && !credId) {
        ctx.notify(`${SYM.warn} Node created with no SSH credential — ensure key-based auth is configured`, "warning");
      } else {
        ctx.notify(`${SYM.ok} Created node: ${result.name}`, "success");
      }
      const ncp = [`bee node create "${result.name}"`, `--remote-dir "${result.remoteDir}"`];
      if (result.numExecutors && result.numExecutors !== "1") ncp.push(`--executors ${result.numExecutors}`);
      if (result.labels) ncp.push(`--labels "${result.labels}"`);
      if (result.desc) ncp.push(`--description "${result.desc}"`);
      if (isSsh) {
        if (result.host) ncp.push(`--host "${result.host}"`);
        if (result.port && result.port !== "22") ncp.push(`--port ${result.port}`);
        if (credId) ncp.push(`--cred-id "${credId}"`);
      }
      if (result.availability === "demand") {
        ncp.push(`--availability demand`);
        if (result.inDemandDelay) ncp.push(`--in-demand-delay ${result.inDemandDelay}`);
        if (result.idleDelay) ncp.push(`--idle-delay ${result.idleDelay}`);
      }
      ctx.logCommand(ncp.join(" "));
      void refetch();
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [ctx, refetch, credentialOptions]);

  const removeNode = useCallback(
    async (name: string): Promise<false | void> => {
      const ok = await ctx.openModal<boolean>({
        id: "confirm-delete-node",
        render: (resolve) => (
          <ConfirmModal
            message={`Delete node '${name}'? This cannot be undone.`}
            onResult={resolve}
          />
        ),
      });
      if (!ok) return false;
      try {
        const client = await ctx.getClient({ useController: true });
        await deleteNode(client, name);
        untrackResource("node", name, ctx.profile, client.baseUrl, ctx.dbPath);
        ctx.notify(`${SYM.ok} Deleted: ${name}`, "success");
        ctx.logCommand(`bee node delete ${name} --yes`);
        void refetch();
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [ctx, refetch],
  );

  const doToggleOffline = useCallback(
    async (node: NodeDTO): Promise<false | void> => {
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
      if (!ok) return false;
      try {
        const client = await ctx.getClient({ useController: true });
        await toggleOffline(client, node.name, "");
        ctx.notify(`${SYM.ok} Marked ${action}: ${node.name}`, "success");
        ctx.logCommand(`bee node ${action} ${node.name}`);
        void refetch();
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [ctx, refetch],
  );

  const editNode = useCallback(
    async (node: NodeDTO): Promise<false | void> => {
      const client = await ctx.getClient({ useController: true });
      let detail;
      try {
        detail = await getNode(client, node.name);
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
        return false;
      }
      const cfg = parseNodeConfig(detail.configXml ?? "");
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
              { name: "remoteDir", label: "Remote Dir", initial: cfg.remoteDir || detail.remoteDir || "", path: true, hint: "Tab completes local FS" },
              { name: "numExecutors", label: "Executors", initial: String(detail.numExecutors ?? 1), hint: "e.g. 1" },
              { name: "labels", label: "Labels", initial: detail.labels ?? "", hint: "space-separated" },
              { name: "desc", label: "Description", initial: detail.description ?? "", hint: "optional" },
              { name: "launcher", label: "Launch method", options: ["ssh", "jnlp"], initial: cfg.launcherType },
              { name: "host", label: "SSH Host", initial: cfg.host, hint: "hostname or IP", visible: (v) => v["launcher"] !== "jnlp" },
              { name: "port", label: "SSH Port", initial: String(cfg.port), hint: "default 22", visible: (v) => v["launcher"] !== "jnlp" },
              { name: "credentialsId", label: "SSH Credential", options: credChoices, searchable: true, initial: credInitial, visible: (v) => v["launcher"] !== "jnlp" },
              { name: "availability", label: "Availability", options: ["always", "demand"], initial: cfg.availability },
              { name: "inDemandDelay", label: "In-demand Delay", initial: String(cfg.inDemandDelay), hint: "minutes", visible: (v) => v["availability"] === "demand" },
              { name: "idleDelay", label: "Idle Delay", initial: String(cfg.idleDelay), hint: "minutes", visible: (v) => v["availability"] === "demand" },
              { name: "controlled", label: "Controlled Agent", options: ["no", "yes"], initial: cfg.controlledAgent ? "yes" : "no", hint: "Folders Plus: restrict to approved folders" },
            ]}
            onResult={resolve}
          />
        ),
      });
      if (!result) return false;
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
          controlledAgent: result.controlled === "yes",
        });
        ctx.notify(`${SYM.ok} Updated node: ${node.name}`, "success");
        if (launcherType === "ssh" && credId === "") {
          ctx.notify(`${SYM.warn} Node has no SSH credential — ensure key-based auth is configured`, "warning");
        }
        const np = [`bee node update ${node.name}`];
        if (result.remoteDir !== (cfg.remoteDir || detail.remoteDir || "")) np.push(`--remote-dir "${result.remoteDir}"`);
        if (result.numExecutors !== String(detail.numExecutors ?? 1)) np.push(`--executors ${result.numExecutors}`);
        if (result.labels !== (detail.labels ?? "")) np.push(`--labels "${result.labels}"`);
        if (result.desc !== (detail.description ?? "")) np.push(`--description "${result.desc}"`);
        if (result.launcher !== cfg.launcherType) np.push(`--launcher ${result.launcher}`);
        if (result.launcher !== "jnlp") {
          if (result.host !== cfg.host) np.push(`--host "${result.host}"`);
          if (result.port !== String(cfg.port)) np.push(`--port ${result.port}`);
          if (result.credentialsId !== credInitial && result.credentialsId !== NONE_OPTION) np.push(`--cred-id "${result.credentialsId}"`);
        }
        if (result.availability !== cfg.availability) np.push(`--availability ${result.availability}`);
        if (result.availability === "demand") {
          if (result.inDemandDelay !== String(cfg.inDemandDelay)) np.push(`--in-demand-delay ${result.inDemandDelay}`);
          if (result.idleDelay !== String(cfg.idleDelay)) np.push(`--idle-delay ${result.idleDelay}`);
        }
        const prevControlled = cfg.controlledAgent ? "yes" : "no";
        if (result.controlled !== prevControlled) np.push(`--controlled-agent ${result.controlled === "yes" ? "true" : "false"}`);
        ctx.logCommand(np.join(" "));
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
      ctx.logCommand(`bee node import ${name}`);
      void refetch();
    },
    [baseUrl, ctx, refetch],
  );

  const doApproveFolder = useCallback(
    (node: NodeDTO): false => {
      setFoldersAgent(node.name);
      return false;
    },
    [],
  );

  const doAddApprovedFolder = useCallback(async () => {
    if (!foldersAgent) return;
    // Fetch folder list for the searchable picker; fall back to free-text if fetch fails.
    let folderOptions: string[] = [];
    try {
      const client = await ctx.getClient({ useController: true });
      const jobs = await listJobsRecursive(client);
      folderOptions = jobs.filter((j) => j.jobType === "FD").map((j) => j.name).sort();
    } catch { /* ignore — fall back to free text */ }

    const result = await ctx.openModal<Record<string, string>>({
      id: "approve-folder-input",
      render: (resolve) => (
        <FormModal
          title={`${SYM.gear} Approve Folder on '${foldersAgent}'`}
          fields={[{
            name: "folder",
            label: "Folder",
            required: true,
            hint: folderOptions.length > 0 ? "type to search" : "e.g. team or team/backend",
            options: folderOptions.length > 0 ? folderOptions : undefined,
            searchable: folderOptions.length > 0 ? true : undefined,
          }]}
          onResult={resolve}
        />
      ),
    });
    if (!result?.folder) return;
    try {
      const client = await ctx.getClient({ useController: true });
      await approveFolder(client, foldersAgent, result.folder);
      ctx.notify(`${SYM.ok} Approved folder '${result.folder}' on '${foldersAgent}'`, "success");
      ctx.logCommand(`bee job approve-agent ${result.folder} ${foldersAgent}`);
      void fetchApprovedFolders(foldersAgent);
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [foldersAgent, ctx, approveFolder, fetchApprovedFolders]);

  const doRevokeApprovedFolder = useCallback(async (item: GrantItem) => {
    if (!foldersAgent) return;
    const ok = await ctx.openModal<boolean>({
      id: "revoke-folder-confirm",
      render: (resolve) => (
        <ConfirmModal
          message={`Revoke token for '${item.label}' on agent '${foldersAgent}'?`}
          onResult={resolve}
        />
      ),
    });
    if (!ok) return;
    try {
      const client = await ctx.getClient({ useController: true });
      await deleteAgentToken(client, foldersAgent, item.id);
      ctx.notify(`${SYM.ok} Token revoked`, "success");
      ctx.logCommand(`bee job remove-agent ${foldersAgent} ${item.label}`);
      void fetchApprovedFolders(foldersAgent);
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [foldersAgent, ctx, fetchApprovedFolders]);

  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const bulkRemoveNodes = useCallback(async (): Promise<false | void> => {
    const targets = selected.size > 0
      ? [...selected]
      : current ? [current.name] : [];
    if (targets.length === 0) return false;
    const preview = targets.slice(0, 5).join(", ");
    const suffix = targets.length > 5 ? `, +${targets.length - 5} more` : "";
    const msg = targets.length === 1
      ? `Delete node '${targets[0]}'? This cannot be undone.`
      : `Delete ${targets.length} nodes: ${preview}${suffix}\n\nThis cannot be undone.`;
    const ok = await ctx.openModal<boolean>({
      id: "confirm-bulk-delete-nodes",
      render: (resolve) => <ConfirmModal message={msg} onResult={resolve} />,
    });
    if (!ok) return false;
    const client = await ctx.getClient({ useController: true });
    let deletedCount = 0;
    for (const name of targets) {
      try {
        await deleteNode(client, name);
        untrackResource("node", name, ctx.profile, client.baseUrl, ctx.dbPath);
        deletedCount++;
      } catch (err) {
        ctx.notify(`Failed: ${name} — ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }
    setSelected(new Set());
    if (deletedCount > 0) {
      ctx.notify(`${SYM.ok} Deleted ${deletedCount} node(s)`, "success");
      ctx.logCommand(targets.map((n) => `bee node delete ${n} --yes`).join("\n"));
      void refetch();
    }
  }, [selected, current, ctx, refetch]);

  // ── Declarative keymap ────────────────────────────────────────────────────
  const hasRow = current !== undefined && current.labels !== "[DELETED_ON_SERVER]";
  // Importable = a real server row not yet in the Mine list (most useful in All view).
  const canImport = hasRow && current !== undefined && !trackedNames.has(current.name);
  // Untrackable = a row currently in the Mine list (can be removed from Mine).
  const canUntrack = hasRow && current !== undefined && trackedNames.has(current.name);

  const menuActions = useMemo(
    () => [
      { label: "Toggle Offline",   icon: SYM.iconToggle,   run: async () => { if (!current) return false as const; return await doToggleOffline(current); } },
      { label: "Edit",             icon: SYM.iconEdit,     run: async () => { if (!current) return false as const; return await editNode(current); } },
      { label: "Approve Folder",   icon: SYM.iconSchedule, run: () => { if (!current) return false as const; return doApproveFolder(current); } },
      { label: "Import",           icon: SYM.iconImport,   when: () => canImport, run: () => { if (current) doImport(current.name); } },
      { label: "Unimport", icon: SYM.iconImport, when: () => canUntrack, run: () => { if (current && baseUrl) { untrackResource("node", current.name, ctx.profile, baseUrl, ctx.dbPath); ctx.notify(`${SYM.ok} Removed '${current.name}' from Mine`, "success"); ctx.logCommand(`bee node unimport ${current.name}`); void refetch(); } } },
      { label: "Delete",           icon: SYM.iconDelete,   danger: true, run: async () => { if (!current) return false as const; return await removeNode(current.name); } },
    ],
    [current, canImport, canUntrack, baseUrl, editNode, doImport, removeNode, doToggleOffline, doApproveFolder, refetch, ctx],
  );

  const bindings = useMemo<KeyBinding[]>(
    () => [
      { key: "Enter", label: "menu", group: "action", when: () => current !== undefined && !menuOpen, run: () => setMenuOpen(true) },
      { key: "ctrl+d", label: selected.size > 0 ? `delete ${selected.size}` : "delete", group: "action",
        when: () => (selected.size > 0 || current !== undefined) && !menuOpen,
        run: () => void bulkRemoveNodes() },
      { key: "ctrl+n", label: "new", run: () => void createNode() },
      { key: "ctrl+a", label: "mine/all", run: () => setShowAll((v) => { const nv = !v; setScopeShowAll("node", nv, ctx.dbPath); return nv; }) },
      { key: "F", label: "auto", run: () => setAutoRefresh((v) => !v) },
      search.openBinding,
      { key: "Esc", label: "clear", hidden: true, when: () => search.active, run: () => search.clear() },
      { key: "r", label: "refresh", run: () => void refetch() },
    ],
    [current, menuOpen, selected, bulkRemoveNodes, createNode, search, refetch, ctx],
  );
  useKeymap(bindings, { isActive: active && !menuOpen && !foldersAgent && !search.editing });
  useEffect(() => {
    if (!active) return;
    if (menuOpen || foldersAgent) ctx.setActiveKeyHints([]);
    else ctx.setActiveKeyHints(bindingsToHints(bindings));
  }, [active, menuOpen, foldersAgent, bindings, ctx]);

  if (foldersAgent) {
    return (
      <GrantListOverlay
        title={`Approved Folders — ${foldersAgent}`}
        subtitle="Folders this agent is allowed to run builds from"
        itemHeader="Folder"
        items={approvedFolderItems}
        emptyText="No approved folders (controlled-agent may not be enabled)."
        addHint="approve folder"
        onAdd={() => void doAddApprovedFolder()}
        onRevoke={(item) => void doRevokeApprovedFolder(item)}
        onRefresh={() => void fetchApprovedFolders(foldersAgent)}
        onClose={() => { setFoldersAgent(null); setMenuOpen(false); }}
        isActive={!ctx.modalActive}
      />
    );
  }

  if (menuOpen && current) {
    return (
      <ContextMenu
        title={`Node: ${current.name}`}
        actions={menuActions}
        onClose={() => setMenuOpen(false)}
        isActive={!ctx.modalActive}
      />
    );
  }

  const notLoggedIn = !ctx.loggedIn;
  const noController = ctx.loggedIn && !ctx.activeController;
  const errMsg = error ? error.message : "";

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* ── Compact header ── */}
      <Box>
        <Text color={THEME.dim}>{SYM.online} Nodes  </Text>
        {showAll
          ? <Text color={THEME.yellow} bold>[ALL]</Text>
          : <Text color={THEME.success} bold>[MINE]</Text>}
        {autoRefresh ? <Text color={THEME.success}>  [auto]</Text> : null}
        {status === "loading" || status === "stale" ? (
          <Text color={THEME.active}>  ⟳ refreshing…</Text>
        ) : null}
      </Box>

      {/* Body */}
      {notLoggedIn ? (
        <Box marginTop={1}>
          <Text color={THEME.warning}>
            {SYM.warn} Not logged in — press Ctrl+l to login
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
                { text: n.name },
                { text: isDeleted ? "-" : String(n.numExecutors) },
                { text: isDeleted ? "[DELETED_ON_SERVER]" : n.labels, dim: isDeleted },
                { text: n.description ?? "" },
              ];
            })}
            rowKeys={rowKeys}
            cursor={cursor}
            onCursorChange={setCursor}
            active={active && !search.editing}
            emptyText="No nodes. Press Ctrl+n to create one."
            selected={selected}
            onToggleSelect={toggleSelect}
          />

          {/* Detail panel */}
          {current && (
            <Box
              flexDirection="column"
              borderStyle={borderStyle()}
              paddingX={1}
              marginTop={1}
            >
              {/* Title + status */}
              <Box>
                <Text bold color={THEME.normal}>{current.displayName || current.name}</Text>
                <Text color={THEME.dim}>{"  "}</Text>
                {current.offline
                  ? <Text color={THEME.warning}>{SYM.offline} offline</Text>
                  : <Text color={THEME.success}>{SYM.online} online</Text>}
                <Text color={THEME.dim}>{"  "}exec {current.numExecutors}</Text>
              </Box>
              {/* Config fields */}
              {nodeConfig && (
                <Box>
                  <Text color={THEME.dim}>launcher </Text>
                  <Text color={THEME.normal}>{nodeConfig.launcherType}</Text>
                  {nodeConfig.launcherType === "ssh" && nodeConfig.host ? (
                    <>
                      <Text color={THEME.subtle}>{"   "}</Text>
                      <Text color={THEME.dim}>host </Text>
                      <Text color={THEME.normal}>{nodeConfig.host}:{nodeConfig.port}</Text>
                    </>
                  ) : null}
                  {nodeConfig.remoteDir ? (
                    <>
                      <Text color={THEME.subtle}>{"   "}</Text>
                      <Text color={THEME.dim}>remote </Text>
                      <Text color={THEME.normal}>{nodeConfig.remoteDir}</Text>
                    </>
                  ) : null}
                </Box>
              )}
              {current.labels && current.labels !== "[DELETED_ON_SERVER]" && (
                <Text color={THEME.dim} wrap="truncate-end">labels {current.labels}</Text>
              )}
              {baseUrl && current.labels !== "[DELETED_ON_SERVER]" && (
                <Text color={THEME.subtle} wrap="truncate-end">
                  {baseUrl.replace(/\/+$/, "")}/computer/{encodeURIComponent(current.name)}/
                </Text>
              )}
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
