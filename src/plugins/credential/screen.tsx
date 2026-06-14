/**
 * Credentials TUI tab — list, create, delete, system/user store toggle,
 * Mine/All filter, inline detail panel.
 *
 * Follows the exact pipeline pattern established in src/plugins/job/screen.tsx:
 *   useResource → computeView → useStableCursor → DataTable
 *
 * Store toggle (S key) is a server-side scope switch — it changes the cache key
 * and triggers a real refetch, unlike Mine/All which is client-side only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { randomUUID } from "node:crypto";
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
import { useResource } from "../../core/tui/data/use-resource";
import { computeView } from "../../core/tui/data/use-view";
import { useSearch } from "../../core/tui/data/use-search";
import { useStableCursor } from "../../core/tui/data/use-stable-cursor";
import { useAutoRefresh } from "../../core/tui/data/use-auto-refresh";
import { getTtl } from "../../core/cache/policy";
import type { CredentialDTO } from "../../core/dtos/credential";
import {
  listCredentials,
  createUsernamePassword,
  createSecretText,
  updateCredential,
  deleteCredential,
  getCredentialConfig,
} from "./service";
import {
  getTrackedResources,
  trackResource,
  untrackResource,
} from "../../core/db/repositories/resource-repo";
import { useDimensions } from "../../core/tui/data/use-dimensions";
import { getScopeShowAll, setScopeShowAll } from "../../core/db/repositories/scope-repo";

// ─── Credentials screen ───────────────────────────────────────────────────────

const CredentialsScreen: FC<TuiScreenProps> = ({ ctx, active }) => {
  const [showAll, setShowAll] = useState(() => getScopeShowAll("credential", ctx.dbPath));
  const [autoRefresh, setAutoRefresh] = useState(false);
  const { columns: termCols } = useDimensions();
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  // Store is a server-side scope — changing it refetches from a different endpoint.
  const [store, setStore] = useState<"system" | "user">("system");
  const [menuOpen, setMenuOpen] = useState(false);
  const [credConfig, setCredConfig] = useState<{ username: string; description: string } | null>(null);
  const credConfigCache = useRef<Map<string, { username: string; description: string }>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());

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
  // Cache key includes store so switching store triggers a new fetch automatically.
  const cacheKey = `credentials.list.${baseUrl ?? "?"}.${store}`;
  const {
    data: allCredentials,
    status,
    error,
    refetch,
    isInitialLoading,
  } = useResource<CredentialDTO[]>(
    cacheKey,
    async () => {
      const client = await ctx.getClient({ useController: true });
      return listCredentials(client, ctx.username, store);
    },
    { ttlMs: getTtl("credentials.list") * 1000, enabled: ctx.loggedIn && baseUrl !== null },
  );

  useAutoRefresh({
    enabled: autoRefresh,
    active,
    refetch,
    policy: { baseMs: 5000, backoffFactor: 2, maxMs: 60000 },
  });

  // Tracked ids for Mine filter + [DELETED_ON_SERVER] synthesis.
  // Resource key includes store so Mine is scoped to the current store.
  const trackedIds = useMemo(() => {
    if (!baseUrl) return new Set<string>();
    return new Set(
      getTrackedResources("credential", ctx.profile, `${baseUrl}.${store}`, ctx.dbPath),
    );
  }, [baseUrl, store, ctx.dbPath, ctx.profile, allCredentials]);

  // ── View pipeline: Mine/All filter + synthetic deleted rows (client-side) ──
  const scoped = useMemo(() => {
    const all = allCredentials ?? [];
    if (showAll) return all;
    const serverIds = new Set(all.map((c) => c.id));
    const mine = computeView(all, {
      filters: { tracked: (c: CredentialDTO) => trackedIds.has(c.id) },
      activeFilters: ["tracked"],
    });
    const deleted: CredentialDTO[] = [];
    for (const id of trackedIds) {
      if (!serverIds.has(id)) {
        deleted.push({
          id,
          displayName: id,
          typeName: "[DELETED_ON_SERVER]",
          scope: "",
          description: "",
        });
      }
    }
    return [...mine, ...deleted];
  }, [allCredentials, showAll, trackedIds]);

  // Then the "/" search filter (matches id + description + typeName), client-side.
  const credentials = useMemo(
    () =>
      computeView(scoped, {
        query: search.query,
        searchText: (c) => `${c.id} ${c.description ?? ""} ${c.typeName ?? ""}`,
      }),
    [scoped, search.query],
  );

  // ── Stable cursor ──────────────────────────────────────────────────────────
  const rowKeys = useMemo(() => credentials.map((c) => c.id), [credentials]);
  const { cursor, setCursor } = useStableCursor(rowKeys);
  const current = credentials[cursor];

  // Fetch and cache credential config (username) for the detail panel.
  useEffect(() => {
    if (!current) { setCredConfig(null); return; }
    const ck = `${current.id}.${store}`;
    const cached = credConfigCache.current.get(ck);
    if (cached) { setCredConfig(cached); return; }
    void (async () => {
      try {
        const cfgClient = await ctx.getClient({ useController: true });
        const cfg = await getCredentialConfig(cfgClient, current.id, ctx.username, store);
        credConfigCache.current.set(ck, cfg);
        setCredConfig(cfg);
      } catch {
        /* best-effort */
      }
    })();
  }, [current?.id, store, ctx]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const createCred = useCallback(async () => {
    // Step 1: pick credential type
    const typeResult = await ctx.openModal<Record<string, string>>({
      id: "create-credential-type",
      render: (resolve) => (
        <FormModal
          title={`${SYM.gear} Create Credential — Type`}
          fields={[
            {
              name: "type",
              label: "Type",
              required: true,
              options: ["Username+Password", "SecretText"],
              hint: "credential type",
            },
          ]}
          onResult={resolve}
        />
      ),
    });
    if (!typeResult) return;

    const isSecret = typeResult.type === "SecretText";

    // Step 2: fill fields based on type
    const result = await ctx.openModal<Record<string, string>>({
      id: "create-credential",
      render: (resolve) =>
        isSecret ? (
          <FormModal
            title={`${SYM.gear} Create SecretText Credential`}
            fields={[
              { name: "id", label: "ID", hint: "blank = auto-generate" },
              { name: "secret", label: "Secret", required: true, password: true, hint: "plain-text secret" },
              { name: "desc", label: "Description", hint: "optional" },
            ]}
            onResult={resolve}
          />
        ) : (
          <FormModal
            title={`${SYM.gear} Create Username+Password Credential`}
            fields={[
              { name: "id", label: "ID", hint: "blank = auto-generate" },
              { name: "username", label: "Username", required: true, hint: "login user" },
              { name: "password", label: "Password", required: true, password: true, hint: "secret token" },
              { name: "desc", label: "Description", hint: "optional" },
            ]}
            onResult={resolve}
          />
        ),
    });
    if (!result) return;
    if (isSecret && !result.secret) return;
    if (!isSecret && (!result.username || !result.password)) return;

    try {
      const client = await ctx.getClient({ useController: true });
      // Auto-generate UUID when user leaves ID blank — mirrors CLI behaviour
      // (CLI: `const credId = opts.id || randomUUID()`). An empty <id> in the
      // XML lets Jenkins generate one server-side, but we can't track it locally.
      const credId = result.id?.trim() || randomUUID();
      const desc = result.desc ?? "";

      if (isSecret) {
        await createSecretText(client, credId, result.secret, desc, "GLOBAL", ctx.username, store);
      } else {
        await createUsernamePassword(
          client, credId, result.username, result.password, desc, "GLOBAL", ctx.username, store,
        );
      }

      if (credId) {
        trackResource("credential", credId, ctx.profile, `${client.baseUrl}.${store}`, ctx.dbPath);
      }
      const displayId = credId || "(auto-generated)";
      ctx.notify(`${SYM.ok} Created credential: ${displayId}`, "success");
      const typeFlag = isSecret ? `--secret-text "***"` : `--username ${result.username}`;
      const storeFlag = store !== "system" ? ` --store ${store}` : "";
      ctx.logCommand(`bee cred create --id ${credId} ${typeFlag}${desc ? ` --description "${desc}"` : ""}${storeFlag}`);
      void refetch();
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [ctx, store, refetch]);

  const editCred = useCallback(
    async (cred: CredentialDTO): Promise<false | void> => {
      let prefill = { username: "", description: cred.description ?? "" };
      try {
        const cfgClient = await ctx.getClient({ useController: true });
        prefill = await getCredentialConfig(cfgClient, cred.id, ctx.username, store);
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
        return false;
      }
      const result = await ctx.openModal<Record<string, string>>({
        id: "edit-credential",
        render: (resolve) => (
          <FormModal
            title={`${SYM.dot} Edit Credential: ${cred.id}`}
            fields={[
              { name: "username", label: "Username", initial: prefill.username, hint: "login user" },
              { name: "password", label: "Password", password: true, hint: "blank = keep current" },
              { name: "desc", label: "Description", initial: prefill.description, hint: "optional" },
            ]}
            onResult={resolve}
          />
        ),
      });
      if (!result) return false;
      try {
        const client = await ctx.getClient({ useController: true });
        await updateCredential(
          client,
          cred.id,
          result.username || undefined,
          result.password || undefined,
          result.desc,
          ctx.username,
          store,
        );
        ctx.notify(`${SYM.ok} Updated credential: ${cred.id}`, "success");
        const cp = [`bee cred update ${cred.id}`];
        if (result.username !== prefill.username) cp.push(`--username "${result.username}"`);
        if (result.password) cp.push(`--password "***"`);
        if (result.desc !== prefill.description) cp.push(`--description "${result.desc}"`);
        if (store !== "system") cp.push(`--store ${store}`);
        ctx.logCommand(cp.join(" "));
        void refetch();
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [ctx, store, refetch],
  );

  const removeCred = useCallback(
    async (id: string): Promise<false | void> => {
      const ok = await ctx.openModal<boolean>({
        id: "confirm-delete-credential",
        render: (resolve) => (
          <ConfirmModal
            message={`Delete credential '${id}'? This cannot be undone.`}
            onResult={resolve}
          />
        ),
      });
      if (!ok) return false;
      try {
        const client = await ctx.getClient({ useController: true });
        await deleteCredential(client, id, ctx.username, store);
        untrackResource(
          "credential",
          id,
          ctx.profile,
          `${client.baseUrl}.${store}`,
          ctx.dbPath,
        );
        ctx.notify(`${SYM.ok} Deleted: ${id}`, "success");
        ctx.logCommand(`bee cred delete ${id} --yes${store !== "system" ? ` --store ${store}` : ""}`);
        void refetch();
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [ctx, store, refetch],
  );

  // Import = track an existing server credential into Mine (for credentials created outside bee).
  const doImport = useCallback(
    (id: string) => {
      if (!baseUrl) return;
      trackResource("credential", id, ctx.profile, `${baseUrl}.${store}`, ctx.dbPath);
      ctx.notify(`${SYM.ok} Imported '${id}' into Mine`, "success");
      ctx.logCommand(`bee cred import ${id}${store !== "system" ? ` --store ${store}` : ""}`);
      void refetch();
    },
    [baseUrl, store, ctx, refetch],
  );

  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const bulkRemoveCreds = useCallback(async (): Promise<false | void> => {
    const targets = selected.size > 0
      ? [...selected]
      : current ? [current.id] : [];
    if (targets.length === 0) return false;
    const preview = targets.slice(0, 5).join(", ");
    const suffix = targets.length > 5 ? `, +${targets.length - 5} more` : "";
    const msg = targets.length === 1
      ? `Delete credential '${targets[0]}'? This cannot be undone.`
      : `Delete ${targets.length} credentials: ${preview}${suffix}\n\nThis cannot be undone.`;
    const ok = await ctx.openModal<boolean>({
      id: "confirm-bulk-delete-creds",
      render: (resolve) => <ConfirmModal message={msg} onResult={resolve} />,
    });
    if (!ok) return false;
    const client = await ctx.getClient({ useController: true });
    let deletedCount = 0;
    for (const id of targets) {
      try {
        await deleteCredential(client, id, ctx.username, store);
        untrackResource("credential", id, ctx.profile, `${client.baseUrl}.${store}`, ctx.dbPath);
        deletedCount++;
      } catch (err) {
        ctx.notify(`Failed: ${id} — ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }
    setSelected(new Set());
    if (deletedCount > 0) {
      ctx.notify(`${SYM.ok} Deleted ${deletedCount} credential(s)`, "success");
      void refetch();
    }
  }, [selected, current, ctx, store, refetch]);

  // ── Declarative keymap ────────────────────────────────────────────────────
  const hasRow = current !== undefined && current.typeName !== "[DELETED_ON_SERVER]";
  // Importable = a real server row not yet in the Mine list (most useful in All view).
  const canImport = hasRow && current !== undefined && !trackedIds.has(current.id);
  // Unimportable = a tracked row that can be removed from Mine.
  const canUntrack = hasRow && current !== undefined && trackedIds.has(current.id);

  const menuActions = useMemo(
    () => [
      { label: "Edit",     icon: SYM.iconEdit,   run: async () => { if (!current) return false as const; return await editCred(current); } },
      { label: "Import",   icon: SYM.iconImport, when: () => canImport, run: () => { if (current) doImport(current.id); } },
      { label: "Unimport", icon: SYM.iconImport, when: () => canUntrack, run: () => { if (current && baseUrl) { untrackResource("credential", current.id, ctx.profile, `${baseUrl}.${store}`, ctx.dbPath); ctx.notify(`${SYM.ok} Removed '${current.id}' from Mine`, "success"); void refetch(); } } },
      { label: "Delete",   icon: SYM.iconDelete, danger: true, run: async () => { if (!current) return false as const; return await removeCred(current.id); } },
    ],
    [current, canImport, canUntrack, baseUrl, store, editCred, doImport, removeCred, refetch, ctx],
  );

  const bindings = useMemo<KeyBinding[]>(
    () => [
      { key: "Enter", label: "menu", group: "action", when: () => current !== undefined && !menuOpen, run: () => setMenuOpen(true) },
      { key: "ctrl+d", label: selected.size > 0 ? `delete ${selected.size}` : "delete", group: "action",
        when: () => (selected.size > 0 || current !== undefined) && !menuOpen,
        run: () => void bulkRemoveCreds() },
      { key: "ctrl+n", label: "new", run: () => void createCred() },
      { key: "S", label: "store", run: () => setStore((s) => (s === "system" ? "user" : "system")) },
      { key: "ctrl+a", label: "mine/all", run: () => setShowAll((v) => { const nv = !v; setScopeShowAll("credential", nv, ctx.dbPath); return nv; }) },
      { key: "F", label: "auto", run: () => setAutoRefresh((v) => !v) },
      search.openBinding,
      { key: "Esc", label: "clear", hidden: true, when: () => search.active, run: () => search.clear() },
      { key: "r", label: "refresh", run: () => void refetch() },
    ],
    [current, menuOpen, selected, bulkRemoveCreds, createCred, search, refetch, ctx],
  );
  useKeymap(bindings, { isActive: active && !menuOpen && !search.editing });
  useEffect(() => {
    if (!active) return;
    if (menuOpen) ctx.setActiveKeyHints([]);
    else ctx.setActiveKeyHints(bindingsToHints(bindings));
  }, [active, menuOpen, bindings, ctx]);

  if (menuOpen && current) {
    return (
      <ContextMenu
        title={`Credential: ${current.id}`}
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
        <Text color={THEME.dim}>{SYM.gear} Credentials  </Text>
        {showAll
          ? <Text color={THEME.yellow} bold>[ALL]</Text>
          : <Text color={THEME.success} bold>[MINE]</Text>}
        <Text color={THEME.dim}>{"  "}</Text>
        <Text color={store === "system" ? THEME.blue : THEME.yellow}>[{store}]</Text>
        {autoRefresh ? <Text color={THEME.success}>  [auto]</Text> : null}
        {status === "stale" ? <Text color={THEME.subtle}>  ⟳</Text> : null}
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
          <Spinner label="Loading credentials…" />
        </Box>
      ) : errMsg && credentials.length === 0 ? (
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
              { header: "ID", width: 28, flex: true },
              { header: "Type", width: 24 },
              { header: "Scope", width: 10 },
              { header: "Description", width: 34, flex: true },
            ]}
            rows={credentials.map((c) => {
              const isDeleted = c.typeName === "[DELETED_ON_SERVER]";
              const mine = trackedIds.has(c.id);
              return [
                { text: mine ? SYM.tracked : "", color: THEME.success },
                { text: c.id },
                {
                  text: isDeleted ? "[DELETED_ON_SERVER]" : c.typeName.slice(0, 23),
                  color: isDeleted ? THEME.error : undefined,
                  dim: isDeleted,
                },
                { text: (c.scope ?? "").slice(0, 10), dim: true },
                { text: c.description ?? "" },
              ];
            })}
            rowKeys={rowKeys}
            cursor={cursor}
            onCursorChange={setCursor}
            active={active && !search.editing}
            emptyText="No credentials. Press Ctrl+n to create one."
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
              <Box>
                <Text bold color={THEME.normal}>{current.id}</Text>
                <Text color={THEME.dim}>{"  "}</Text>
                <Text color={THEME.blue}>{current.typeName || "—"}</Text>
              </Box>
              <Box>
                {credConfig?.username && (
                  <>
                    <Text color={THEME.dim}>user </Text>
                    <Text color={THEME.normal}>{credConfig.username}</Text>
                    <Text color={THEME.subtle}>{"   "}</Text>
                  </>
                )}
                <Text color={THEME.dim}>scope </Text>
                <Text color={THEME.normal}>{current.scope || "—"}</Text>
                <Text color={THEME.subtle}>{"   "}</Text>
                <Text color={THEME.dim}>store </Text>
                <Text color={store === "system" ? THEME.blue : THEME.yellow}>{store}</Text>
              </Box>
              {current.displayName && current.displayName !== current.id && (
                <Text color={THEME.dim} wrap="truncate-end">{current.displayName}</Text>
              )}
              {baseUrl && (
                <Text color={THEME.subtle} wrap="truncate-end">
                  {store === "user"
                    ? `${baseUrl.replace(/\/+$/, "")}/user/${ctx.username}/credentials/store/user/domain/_/credential/${current.id}/`
                    : `${baseUrl.replace(/\/+$/, "")}/credentials/store/system/domain/_/credential/${current.id}/`}
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
export function credentialScreen(): TuiScreen {
  return {
    id: "credentials",
    title: "Credentials",
    order: 5,
    icon: SYM.gear,
    Component: CredentialsScreen,
  };
}
