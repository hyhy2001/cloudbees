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
import type { CredentialDTO } from "../../core/dtos/credential";
import {
  listCredentials,
  createUsernamePassword,
  updateCredential,
  deleteCredential,
} from "./service";
import {
  getTrackedResources,
  trackResource,
  untrackResource,
} from "../../core/db/repositories/resource-repo";

const PROFILE = "default";

// ─── Credentials screen ───────────────────────────────────────────────────────

const CredentialsScreen: FC<TuiScreenProps> = ({ ctx, active }) => {
  const [showAll, setShowAll] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  // Store is a server-side scope — changing it refetches from a different endpoint.
  const [store, setStore] = useState<"system" | "user">("system");

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
      getTrackedResources("credential", PROFILE, `${baseUrl}.${store}`, ctx.dbPath),
    );
  }, [baseUrl, store, ctx.dbPath, allCredentials]);

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

  // ── Actions ────────────────────────────────────────────────────────────────

  const createCred = useCallback(async () => {
    const result = await ctx.openModal<Record<string, string>>({
      id: "create-credential",
      render: (resolve) => (
        <FormModal
          title={`${SYM.gear} Create Credential`}
          fields={[
            { name: "id", label: "ID", required: true },
            { name: "username", label: "Username", required: true },
            { name: "password", label: "Password", required: true, password: true },
            { name: "desc", label: "Description" },
          ]}
          onResult={resolve}
        />
      ),
    });
    if (!result || !result.id || !result.username || !result.password) return;
    try {
      const client = await ctx.getClient({ useController: true });
      await createUsernamePassword(
        client,
        result.id,
        result.username,
        result.password,
        result.desc ?? "",
        "GLOBAL",
        ctx.username,
        store,
      );
      trackResource(
        "credential",
        result.id,
        PROFILE,
        `${client.baseUrl}.${store}`,
        ctx.dbPath,
      );
      ctx.notify(`${SYM.ok} Created credential: ${result.id}`, "success");
      void refetch();
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [ctx, store, refetch]);

  // Edit = partial update of an existing credential. Password can't be read back
  // and username isn't in the list DTO, so those are blank = unchanged. Only the
  // description is prefilled. Blank username/password → undefined (keeps existing).
  const editCred = useCallback(
    async (cred: CredentialDTO) => {
      const result = await ctx.openModal<Record<string, string>>({
        id: "edit-credential",
        render: (resolve) => (
          <FormModal
            title={`${SYM.dot} Edit Credential: ${cred.id}`}
            fields={[
              { name: "username", label: "Username", placeholder: "leave blank = unchanged" },
              { name: "password", label: "Password", password: true, placeholder: "leave blank = unchanged" },
              { name: "desc", label: "Description", initial: cred.description ?? "" },
            ]}
            onResult={resolve}
          />
        ),
      });
      if (!result) return;
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
        void refetch();
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [ctx, store, refetch],
  );

  const removeCred = useCallback(
    async (id: string) => {
      const ok = await ctx.openModal<boolean>({
        id: "confirm-delete-credential",
        render: (resolve) => (
          <ConfirmModal
            message={`Delete credential '${id}'? This cannot be undone.`}
            onResult={resolve}
          />
        ),
      });
      if (!ok) return;
      try {
        const client = await ctx.getClient({ useController: true });
        await deleteCredential(client, id, ctx.username, store);
        untrackResource(
          "credential",
          id,
          PROFILE,
          `${client.baseUrl}.${store}`,
          ctx.dbPath,
        );
        ctx.notify(`${SYM.ok} Deleted: ${id}`, "success");
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
      trackResource("credential", id, PROFILE, `${baseUrl}.${store}`, ctx.dbPath);
      ctx.notify(`${SYM.ok} Imported '${id}' into Mine`, "success");
      void refetch();
    },
    [baseUrl, store, ctx, refetch],
  );

  // ── Declarative keymap ────────────────────────────────────────────────────
  const hasRow = current !== undefined && current.typeName !== "[DELETED_ON_SERVER]";
  // Importable = a real server row not yet in the Mine list (most useful in All view).
  const canImport = hasRow && current !== undefined && !trackedIds.has(current.id);
  const bindings = useMemo<KeyBinding[]>(
    () => [
      { key: "c", label: "new", run: () => void createCred() },
      { key: "e", label: "edit", when: () => hasRow, run: () => { if (current) void editCred(current); } },
      { key: "i", label: "import", when: () => canImport, run: () => { if (current) doImport(current.id); } },
      { key: "d", label: "del", when: () => hasRow, run: () => { if (current) void removeCred(current.id); } },
      { key: "S", label: "store", run: () => setStore((s) => (s === "system" ? "user" : "system")) },
      { key: "a", label: "mine/all", run: () => setShowAll((v) => !v) },
      { key: "F", label: "auto", run: () => setAutoRefresh((v) => !v) },
      search.openBinding,
      { key: "Esc", label: "clear", hidden: true, when: () => search.active, run: () => search.clear() },
      { key: "R", label: "refresh", run: () => void refetch() },
    ],
    [current, hasRow, canImport, createCred, editCred, doImport, removeCred, refetch, search],
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
        {SYM.gear} Credentials
      </Text>
      <Text>
        {" "}
        {SYM.arrow} Scope: {scope}
        {"  "}
        <Text color={THEME.dim}>store:</Text>{" "}
        <Text color={store === "system" ? THEME.blue : THEME.yellow}>{store}</Text>
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
            columns={[
              { header: "", width: 2 },
              { header: "ID", width: 28 },
              { header: "Type", width: 22 },
              { header: "Scope", width: 10 },
              { header: "Description", width: 34 },
            ]}
            rows={credentials.map((c) => {
              const isDeleted = c.typeName === "[DELETED_ON_SERVER]";
              const mine = trackedIds.has(c.id);
              return [
                { text: mine ? SYM.tracked : "", color: THEME.success },
                { text: c.id.slice(0, 28) },
                {
                  text: isDeleted ? "[DELETED_ON_SERVER]" : c.typeName.slice(0, 22),
                  color: isDeleted ? THEME.error : undefined,
                  dim: isDeleted,
                },
                { text: (c.scope ?? "").slice(0, 10), dim: true },
                { text: (c.description ?? "").slice(0, 34) },
              ];
            })}
            rowKeys={rowKeys}
            cursor={cursor}
            onCursorChange={setCursor}
            active={active && !search.editing}
            emptyText="No credentials. Press c to create one."
          />

          {/* Detail panel */}
          {current && (
            <Box flexDirection="column" borderStyle={borderStyle()} paddingX={1} marginTop={1}>
              <Text>
                <Text bold>{current.id}</Text>
                {"   "}
                <Text color={THEME.dim}>type:</Text> {current.typeName || "-"}
                {"   "}
                <Text color={THEME.dim}>scope:</Text> {current.scope || "-"}
              </Text>
              {current.displayName && current.displayName !== current.id && (
                <Text color={THEME.dim} wrap="truncate-end">
                  display: {current.displayName}
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
export function credentialScreen(): TuiScreen {
  return {
    id: "credentials",
    title: "Credentials",
    order: 5,
    icon: SYM.gear,
    Component: CredentialsScreen,
  };
}
