/**
 * Folders Plus TUI tab — approve folders on controlled agents.
 *
 * Lists all agents that have controlled-agent mode enabled, shows their
 * approved folders, and allows approving new folders via the handshake.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import type { FC } from "react";
import type { TuiScreen, TuiScreenProps } from "../../registry/types";
import { SYM, borderStyle } from "../../core/tui/symbols";
import { THEME } from "../../core/tui/theme";
import { Spinner } from "../../core/tui/components/Spinner";
import { DataTable } from "../../core/tui/components/DataTable";
import { FormModal } from "../../core/tui/components/FormModal";
import { ConfirmModal } from "../../core/tui/components/ConfirmModal";
import { useKeymap, bindingsToHints, type KeyBinding } from "../../core/tui/keymap";
import { useResource } from "../../core/tui/data/use-resource";
import { useStableCursor } from "../../core/tui/data/use-stable-cursor";
import { useSearch } from "../../core/tui/data/use-search";
import { SearchBar } from "../../core/tui/components/SearchBar";
import { useDimensions } from "../../core/tui/data/use-dimensions";
import { getTtl } from "../../core/cache/policy";
import { listNodes } from "../node/service";
import { approveFolder, setControlledAgent } from "./service";
import type { NodeDTO } from "../../core/dtos/node";

// ─── Folders Plus screen ──────────────────────────────────────────────────────

const FoldersPlusScreen: FC<TuiScreenProps> = ({ ctx, active }) => {
  const { columns: termCols } = useDimensions();
  const [baseUrl, setBaseUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!ctx.loggedIn) return;
    void (async () => {
      try {
        const client = await ctx.getClient({ useController: true });
        if (!cancelled) setBaseUrl(client.baseUrl);
      } catch { /* surfaced via resource error */ }
    })();
    return () => { cancelled = true; };
  }, [ctx]);

  const cacheKey = `nodes.list.${baseUrl ?? "?"}`;
  const { data: allNodes, status, error, refetch, isInitialLoading } = useResource<NodeDTO[]>(
    cacheKey,
    async () => {
      const client = await ctx.getClient({ useController: true });
      return listNodes(client);
    },
    { ttlMs: getTtl("nodes.*") * 1000, enabled: ctx.loggedIn && baseUrl !== null },
  );

  // Show only agents with controlled-agent enabled (SecurityTokensNodeProperty).
  // We detect this by checking the node labels column for now — a full check
  // would require fetching config.xml per node (expensive). Instead, show all
  // nodes and let the user pick; the approve action will enable it if needed.
  const nodes = useMemo(() => allNodes ?? [], [allNodes]);

  const search = useSearch({ isActive: active, onEditingChange: ctx.setInputCaptured });

  const filtered = useMemo(() => {
    const q = search.query.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter((n) =>
      n.name.toLowerCase().includes(q) || (n.labels ?? "").toLowerCase().includes(q),
    );
  }, [nodes, search.query]);

  const rowKeys = useMemo(() => filtered.map((n) => n.name), [filtered]);
  const { cursor, setCursor } = useStableCursor(rowKeys);
  const current = filtered[cursor];

  const tableRows = useMemo(
    () =>
      filtered.map((n) => [
        { text: n.offline ? SYM.fail : SYM.ok, color: n.offline ? THEME.error : THEME.success },
        { text: n.name },
        { text: n.labels ?? "" },
        { text: n.description ?? "" },
      ]),
    [filtered],
  );

  const doApproveFolder = useCallback(async () => {
    if (!current) return;
    const result = await ctx.openModal<Record<string, string>>({
      id: "fp-approve-folder",
      render: (resolve) => (
        <FormModal
          title={`${SYM.gear} Approve Folder on '${current.name}'`}
          fields={[
            { name: "folder", label: "Folder Path", required: true, hint: "e.g. team or team/backend" },
          ]}
          onResult={resolve}
        />
      ),
    });
    if (!result?.folder) return;
    try {
      const client = await ctx.getClient({ useController: true });
      ctx.notify(`Running handshake for '${result.folder}' on '${current.name}'…`, "success");
      await approveFolder(client, current.name, result.folder);
      ctx.notify(`${SYM.ok} Approved folder '${result.folder}' on '${current.name}'`, "success");
      ctx.logCommand(`bee foldersplus approve-folder ${current.name} ${result.folder}`);
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [current, ctx]);

  const doToggleControlled = useCallback(async () => {
    if (!current) return;
    let isEnabled = false;
    try {
      const client = await ctx.getClient({ useController: true });
      const xml = await client.getText(`/computer/${encodeURIComponent(current.name)}/config.xml`);
      isEnabled = xml.includes("SecurityTokensNodeProperty");
    } catch { /* assume disabled */ }
    const action = isEnabled ? "disable" : "enable";
    const ok = await ctx.openModal<boolean>({
      id: "fp-toggle-controlled",
      render: (resolve) => (
        <ConfirmModal
          message={`${action === "enable" ? "Enable" : "Disable"} controlled-agent on '${current.name}'?`}
          onResult={resolve}
        />
      ),
    });
    if (!ok) return;
    try {
      const client = await ctx.getClient({ useController: true });
      await setControlledAgent(client, current.name, !isEnabled);
      ctx.notify(`${SYM.ok} Controlled-agent ${action}d on '${current.name}'`, "success");
      ctx.logCommand(`bee node update ${current.name} --controlled-agent ${String(!isEnabled)}`);
      void refetch();
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [current, ctx, refetch]);

  const bindings = useMemo<KeyBinding[]>(
    () => [
      { key: "a", label: "approve folder", group: "action", when: () => current !== undefined, run: () => void doApproveFolder() },
      { key: "t", label: "toggle controlled", group: "action", when: () => current !== undefined, run: () => void doToggleControlled() },
      { key: "r", label: "refresh", run: () => void refetch() },
      search.openBinding,
      { key: "Esc", label: "clear", hidden: true, when: () => search.active, run: () => search.clear() },
    ],
    [current, doApproveFolder, doToggleControlled, refetch, search],
  );

  useKeymap(bindings, { isActive: active && !search.editing });

  useEffect(() => {
    if (!active) return;
    ctx.setActiveKeyHints(bindingsToHints(bindings));
  }, [active, bindings, ctx]);

  const notLoggedIn = !ctx.loggedIn;
  const noController = ctx.loggedIn && !ctx.activeController;
  const errMsg = error ? error.message : "";

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        <Text color={THEME.dim}>{SYM.gear} Folders Plus  </Text>
        <Text color={THEME.blue} bold>[Controlled Agents]</Text>
        {status === "loading" || status === "stale" ? (
          <Text color={THEME.active}>  ⟳ refreshing…</Text>
        ) : null}
      </Box>

      {notLoggedIn ? (
        <Box marginTop={1}>
          <Text color={THEME.warning}>{SYM.warn} Not logged in — press Ctrl+l to login</Text>
        </Box>
      ) : noController ? (
        <Box marginTop={1}>
          <Text color={THEME.warning}>{SYM.warn} No controller selected</Text>
        </Box>
      ) : isInitialLoading ? (
        <Box marginTop={1}><Spinner label="Loading nodes…" /></Box>
      ) : errMsg && nodes.length === 0 ? (
        <Box marginTop={1}>
          <Text color={THEME.error}>{SYM.fail} {errMsg}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {errMsg && <Text color={THEME.error}>{SYM.fail} {errMsg}</Text>}
          <SearchBar state={search} />
          <DataTable
            tableWidth={termCols}
            columns={[
              { header: "", width: 2 },
              { header: "Agent", width: 30, flex: true },
              { header: "Labels", width: 25, flex: true },
              { header: "Description", width: 30, flex: true },
            ]}
            rows={tableRows}
            rowKeys={rowKeys}
            cursor={cursor}
            onCursorChange={setCursor}
            active={active && !search.editing}
            emptyText="No agents found."
          />
          {current && (
            <Box borderStyle={borderStyle()} paddingX={1} marginTop={1}>
              <Text bold color={THEME.normal}>{current.name}</Text>
              <Text color={THEME.dim}>{"  "}{current.offline ? "OFFLINE" : "ONLINE"}</Text>
              {current.labels ? <Text color={THEME.dim}>{"  "}{current.labels}</Text> : null}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};

export function foldersPlusScreen(): TuiScreen {
  return {
    id: "foldersplus",
    title: "FoldersPlus",
    order: 6,
    icon: SYM.gear,
    Component: FoldersPlusScreen,
  };
}
