/**
 * Jobs TUI tab — port of legacy/cb/tui/screens/jobs_screen.py.
 *
 * Full feature parity with the CLI: list, run, stop, view log, create, delete,
 * Mine/All toggle with tracked-resource filtering, and a per-cursor detail panel.
 *
 * The component talks to the SAME service layer as the CLI (src/plugins/job/service.ts)
 * — no logic is duplicated here, only presentation + interaction.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { FC } from "react";
import type { TuiScreen, TuiScreenProps, TuiContext } from "../../registry/types";
import { SYM, borderStyle } from "../../core/tui/symbols";
import { THEME } from "../../core/tui/theme";
import { Spinner } from "../../core/tui/components/Spinner";
import { DataTable } from "../../core/tui/components/DataTable";
import { SearchBar } from "../../core/tui/components/SearchBar";
import { ConfirmModal } from "../../core/tui/components/ConfirmModal";
import { FormModal } from "../../core/tui/components/FormModal";
import { ParamListEditor } from "../../core/tui/components/ParamListEditor";
import { useKeymap, bindingsToHints, type KeyBinding } from "../../core/tui/keymap";
import { useResource } from "../../core/tui/data/use-resource";
import { computeView } from "../../core/tui/data/use-view";
import { useSearch } from "../../core/tui/data/use-search";
import { useStableCursor } from "../../core/tui/data/use-stable-cursor";
import { appendChunk, colorForLine } from "../../core/tui/data/log-buffer";
import { useAutoRefresh } from "../../core/tui/data/use-auto-refresh";
import { useDimensions } from "../../core/tui/data/use-dimensions";
import { getTtl } from "../../core/cache/policy";
import type { JobDTO } from "../../core/dtos/job";
import {
  listJobs,
  listJobsInFolder,
  getJobConfigSummary,
  triggerJob,
  triggerJobWithParams,
  stopBuild,
  deleteJob,
  createFreestyleJob,
  createFolder,
  streamLastBuildLog,
  streamBuildLog,
  getBuildHistory,
  updateJobFreestyle,
  copyJob,
  listControlledAgents,
  approveAgentForFolder,
  removeControlledAgentGrant,
} from "./service";
import type { ControlledAgentGrant } from "./service";
import { getTrackedResources, trackResource, untrackResource } from "../../core/db/repositories/resource-repo";
import { getScopeShowAll, setScopeShowAll } from "../../core/db/repositories/scope-repo";
import { useMineOptions, NONE_OPTION } from "../../core/tui/data/use-mine-options";
import { listNodes } from "../node/service";
import { hasPlugin } from "../system/service";
import { ScheduleBuilder } from "../../core/tui/components/ScheduleBuilder";
import { EmailBuilder, type EmailSpec } from "../../core/tui/components/EmailBuilder";
import { ContextMenu } from "../../core/tui/components/ContextMenu";
import { GrantListOverlay, type GrantItem } from "../../core/tui/components/GrantListOverlay";
import { parseCron } from "../../domain/schedule";

import type { JobConfigSummary } from "./types";

interface StatusCell {
  text: string;
  color?: string;
  dim?: boolean;
}

function statusCell(color: string): StatusCell {
  const running = color.includes("_anime");
  const base = color.replace("_anime", "");
  const map: Record<string, StatusCell> = {
    blue: { text: `${SYM.ok}  OK  `, color: THEME.success },
    red: { text: `${SYM.fail} FAIL`, color: THEME.error },
    yellow: { text: `${SYM.warn} WARN`, color: THEME.warning },
    aborted: { text: `${SYM.aborted} ABT `, dim: true },
    notbuilt: { text: `${SYM.notbuilt} NEW `, dim: true },
    disabled: { text: `${SYM.disabled} DIS `, dim: true },
  };
  const cell = map[base] ?? { text: base.slice(0, 4) || "----", dim: true };
  if (running) return { ...cell, text: `${cell.text} ${SYM.running}` };
  return cell;
}

/**
 * Map a jobType code (already normalised by classToJobType in dtos/job.ts)
 * to a display label + colour. No substring matching here — the DTO layer
 * is the single source of truth for type detection.
 */
function typeLabel(jobType: string | undefined): { text: string; color?: string } {
  switch (jobType) {
    case "FS": return { text: "FS", color: "cyan" };
    case "PL": return { text: "PL", color: THEME.blue };
    case "FD": return { text: "FD", color: THEME.yellow };
    case "MB": return { text: "MB", color: THEME.blue };
    default:   return { text: jobType || "--", color: THEME.dim };
  }
}

// Container types hold child jobs and are drillable (Enter descends into them):
// FD = Folder, MB = MultiBranch / Organization Folder.
function isContainer(jobType: string | undefined): boolean {
  return jobType === "FD" || jobType === "MB";
}

// ─── Log viewer overlay (port of log_screen.py streaming) ────────────────────

interface LogViewerProps {
  ctx: TuiContext;
  jobName: string;
  onClose: () => void;
}

const POLL_MS = 2000;

const LOG_PAGE = 10;

const LogViewer: FC<LogViewerProps> = ({ ctx, jobName, onClose }) => {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState("connecting…");
  const offsetRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  const getClientRef = useRef(ctx.getClient);
  getClientRef.current = ctx.getClient;
  const { rows: termRows, columns: termCols } = useDimensions();

  // Build history: sorted descending (latest first). null = not loaded yet.
  const [buildNums, setBuildNums] = useState<number[] | null>(null);
  const [buildIdx, setBuildIdx] = useState(0);

  // Scroll offset (top line index into `lines`). -1 = pinned to bottom (auto-scroll).
  const [scrollTop, setScrollTop] = useState(-1);

  // Reserve rows: border(2) + title(1) + margin(1) + statusbar(1) + footer(1) = 6
  const logRows = Math.max(5, termRows - 8);

  const totalLines = lines.length;
  // When pinned (-1), show the last logRows lines.
  const effectiveTop = scrollTop < 0
    ? Math.max(0, totalLines - logRows)
    : Math.min(scrollTop, Math.max(0, totalLines - logRows));

  const canScrollUp = effectiveTop > 0;
  const canScrollDown = effectiveTop + logRows < totalLines;

  const scrollBy = useCallback((delta: number) => {
    setScrollTop((prev) => {
      const base = prev < 0 ? Math.max(0, totalLines - logRows) : prev;
      const next = Math.max(0, Math.min(base + delta, Math.max(0, totalLines - logRows)));
      // Re-pin to bottom when scrolled all the way down.
      return next >= Math.max(0, totalLines - logRows) ? -1 : next;
    });
  }, [totalLines, logRows]);

  // When new lines arrive and we are pinned to bottom, stay pinned (no action needed
  // since effectiveTop is recomputed from totalLines). If user has scrolled up,
  // don't jump them back.

  // Fetch build history once on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const client = await ctx.getClient({ useController: true });
        const history = await getBuildHistory(client, jobName, 20);
        const nums = history.map((b) => b.number).sort((a, b) => b - a);
        if (!cancelled) setBuildNums(nums.length > 0 ? nums : null);
      } catch {
        if (!cancelled) setBuildNums(null);
      }
    })();
    return () => { cancelled = true; };
  }, [ctx, jobName]);

  const buildNum = buildNums?.[buildIdx] ?? null;

  useEffect(() => {
    ctx.setInputCaptured(true);
    return () => ctx.setInputCaptured(false);
  }, [ctx]);

  const goNewer = useCallback(() => { setBuildIdx((i) => Math.max(0, i - 1)); }, []);
  const goOlder = useCallback(() => {
    setBuildIdx((i) => (buildNums ? Math.min(buildNums.length - 1, i + 1) : i));
  }, [buildNums]);

  useKeymap(
    [
      { key: "Esc",    label: "back",  group: "nav", run: onClose },
      { key: "down",   label: "↓",    group: "nav", hidden: true, when: () => canScrollDown, run: () => scrollBy(1) },
      { key: "up",     label: "↑",    group: "nav", hidden: true, when: () => canScrollUp,   run: () => scrollBy(-1) },
      { key: "ctrl+f", label: "pgdn", group: "nav", hidden: true, when: () => canScrollDown, run: () => scrollBy(LOG_PAGE) },
      { key: "ctrl+b", label: "pgup", group: "nav", hidden: true, when: () => canScrollUp,   run: () => scrollBy(-LOG_PAGE) },
      { key: "Home",   label: "top",  group: "nav", hidden: true, run: () => setScrollTop(0) },
      { key: "End",    label: "bottom", group: "nav", hidden: true, run: () => setScrollTop(-1) },
      { key: "[", label: "older", run: goOlder, when: () => buildNums != null && buildIdx < (buildNums?.length ?? 0) - 1 },
      { key: "]", label: "newer", run: goNewer, when: () => buildIdx > 0 },
    ],
    { isActive: true },
  );

  // Re-stream whenever the target build changes; reset scroll to bottom.
  useEffect(() => {
    setLines([]);
    setScrollTop(-1);
    setStatus("connecting…");
    offsetRef.current = 0;
    if (timerRef.current) clearTimeout(timerRef.current);

    // Per-effect local flag — avoids the race where React clears the previous
    // effect (setting cancelledRef=true) then immediately re-runs this effect
    // (setting cancelledRef=false) before the previous in-flight fetch resolves.
    let cancelled = false;
    cancelledRef.current = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const client = await getClientRef.current({ useController: true });
        let text: string, newOffset: number, hasMore: boolean;
        if (buildNum != null) {
          [text, newOffset, hasMore] = await streamBuildLog(client, jobName, buildNum, offsetRef.current);
        } else {
          [text, newOffset, hasMore] = await streamLastBuildLog(client, jobName, offsetRef.current);
        }
        if (cancelled) return;
        if (text) {
          setLines((prev) => appendChunk(prev, text));
          offsetRef.current = newOffset;
        }
        if (hasMore) {
          setStatus("streaming…");
          timerRef.current = setTimeout(poll, POLL_MS);
        } else {
          setStatus("stream finished");
        }
      } catch (err) {
        if (cancelled) return;
        setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    void poll();

    return () => {
      cancelled = true;
      cancelledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [jobName, buildNum]);

  const visible = lines.slice(effectiveTop, effectiveTop + logRows);

  const buildLabel = buildNum != null
    ? `#${buildNum}${buildNums ? ` [${buildIdx + 1}/${buildNums.length}]` : ""}`
    : "latest";

  // Memoize scrollbar: rebuilding Array.from({length: logRows}) on every poll
  // (every 2 s) is wasteful when position hasn't changed.
  const scrollbar = useMemo(() => {
    if (totalLines <= logRows) return Array<string>(logRows).fill(" ");
    const trackH = logRows;
    const thumbH = Math.max(1, Math.round((logRows / totalLines) * trackH));
    const thumbTop = Math.round((effectiveTop / Math.max(1, totalLines - logRows)) * (trackH - thumbH));
    return Array.from({ length: trackH }, (_, i) =>
      i >= thumbTop && i < thumbTop + thumbH ? "█" : "│"
    );
  }, [totalLines, logRows, effectiveTop]);
  const contentWidth = Math.max(10, termCols - 6); // border(2)+padding(2)+scrollbar(1)+gap(1)

  return (
    <Box flexDirection="column" borderStyle={borderStyle()} paddingX={1} height={termRows - 4}>
      <Text>
        {SYM.arrow} Log: <Text bold>{jobName}</Text>{" "}
        <Text color={THEME.dim}>
          {buildLabel} [{status}]{buildNums && buildNums.length > 1 ? " · [=older ]=newer" : ""}
        </Text>
      </Text>
      <Box flexDirection="row" marginTop={1}>
        {/* Log lines */}
        <Box flexDirection="column" flexGrow={1}>
          {visible.length === 0 ? (
            <Text color={THEME.dim}>(no output yet)</Text>
          ) : (
            visible.map((line, i) => (
              <Text key={effectiveTop + i} color={colorForLine(line)} wrap="truncate-end">
                {line.slice(0, contentWidth) || " "}
              </Text>
            ))
          )}
        </Box>
        {/* Scrollbar */}
        {totalLines > logRows && (
          <Box flexDirection="column" marginLeft={1}>
            {scrollbar.map((ch, i) => (
              <Text key={i} color={THEME.dim}>{ch}</Text>
            ))}
          </Box>
        )}
      </Box>
      {/* Scroll position hint */}
      <Text color={THEME.dim}>
        {totalLines > logRows
          ? ` lines ${effectiveTop + 1}–${Math.min(effectiveTop + logRows, totalLines)}/${totalLines}${scrollTop < 0 ? " [bottom]" : ""} · `
          : " "}↑/↓ scroll · Home/End top/bottom · Esc back
      </Text>
    </Box>
  );
};

// ─── Jobs screen ─────────────────────────────────────────────────────────────

const JobsScreen: FC<TuiScreenProps> = ({ ctx, active }) => {
  // Mine/All is now a pure client-side filter — no refetch on toggle (P6).
  // Initial scope is persisted per resource-type (Q10).
  const [showAll, setShowAll] = useState(() => getScopeShowAll("job", ctx.dbPath));
  // Folder navigation stack — empty = root, each entry is a folder name (qualified).
  const [folderStack, setFolderStack] = useState<string[]>([]);
  // Live terminal width for auto-scaling the table (Q4).
  const { columns: termCols } = useDimensions();
  // Opt-in auto-refresh (legacy P13): OFF by default, toggled with `f`.
  const [autoRefresh, setAutoRefresh] = useState(false);
  // The screen's HTTP base url, captured once a client is available. Used both
  // as the resource cache key and for tracked-resource lookups.
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  // Multi-select state — set of job names selected via Space.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Overlays local to this tab.
  const [logJob, setLogJob] = useState<string | null>(null);
  // Job whose build parameters are being edited (ParamListEditor overlay).
  const [paramJob, setParamJob] = useState<string | null>(null);
  // Job whose schedule is being edited (ScheduleBuilder overlay). Holds the
  // job name + its current cron (so the builder prefills from it).
  const [scheduleJob, setScheduleJob] = useState<{ name: string; cron: string } | null>(null);
  // Job whose email config is being edited (EmailBuilder overlay).
  const [emailJob, setEmailJob] = useState<{ name: string; spec: EmailSpec } | null>(null);
  // Whether the email-ext plugin is installed on the server. Checked once per
  // login session; fails open (true) when the API returns 403 or errors.
  const [emailExtAvailable, setEmailExtAvailable] = useState(true);
  // When true, the context menu is open for the current job row.
  const [menuOpen, setMenuOpen] = useState(false);
  // Controlled-agents overlay: the folder whose grants are being viewed (null = closed).
  const [agentsFolder, setAgentsFolder] = useState<string | null>(null);
  const [agentGrantItems, setAgentGrantItems] = useState<GrantItem[] | null>(null);

  // Inline "/" search box. Suspended while log/email/agentsFolder overlay is open.
  const search = useSearch({ isActive: active && logJob === null && emailJob === null && agentsFolder === null, onEditingChange: ctx.setInputCaptured });

  // Resolve the controller base url once (cheap; client-factory caches session).
  // Also checks for email-ext plugin availability in the same pass.
  useEffect(() => {
    let cancelled = false;
    if (!ctx.loggedIn) return;
    void (async () => {
      try {
        const client = await ctx.getClient({ useController: true });
        if (!cancelled) setBaseUrl(client.baseUrl);
        const available = await hasPlugin(client, "email-ext");
        if (!cancelled) setEmailExtAvailable(available);
      } catch {
        /* surfaced via the resource error below */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  // ── Read pipeline: list jobs via the ResourceStore (TTL, dedup, stale) ──
  const currentFolder = folderStack[folderStack.length - 1] ?? null;
  const cacheKey = `jobs.list.${baseUrl ?? "?"}.${currentFolder ?? "root"}`;
  const {
    data: allJobs,
    status,
    error,
    refetch,
    isInitialLoading,
  } = useResource<JobDTO[]>(
    cacheKey,
    async () => {
      const client = await ctx.getClient({ useController: true });
      return currentFolder ? listJobsInFolder(client, currentFolder) : listJobs(client);
    },
    { ttlMs: getTtl("jobs.list") * 1000, enabled: ctx.loggedIn && baseUrl !== null },
  );

  // Opt-in background polling — only while this tab is active and no log overlay.
  useAutoRefresh({
    enabled: autoRefresh,
    active: active && logJob === null,
    refetch,
    policy: { baseMs: 5000, backoffFactor: 2, maxMs: 60000 },
  });

  // Tracked names for the Mine filter + [DELETED_ON_SERVER] synthesis.
  const trackedNames = useMemo(() => {
    if (!baseUrl) return new Set<string>();
    return new Set(getTrackedResources("job", ctx.profile, baseUrl, ctx.dbPath));
  }, [baseUrl, ctx.dbPath, ctx.profile, allJobs]);

  // Mine nodes → dropdown options for the job's Node/Label field. "(none)" maps
  // to "run anywhere" (no assignedNode). Fetched in the background once ready.
  const trackedNodeNames = useMemo(() => {
    if (!baseUrl) return new Set<string>();
    return new Set(getTrackedResources("node", ctx.profile, baseUrl, ctx.dbPath));
  }, [baseUrl, ctx.dbPath, ctx.profile]);
  const nodeOptions = useMineOptions({
    enabled: ctx.loggedIn && baseUrl !== null,
    fetch: async () => {
      const client = await ctx.getClient({ useController: true });
      return (await listNodes(client)).map((n) => n.name);
    },
    tracked: trackedNodeNames,
  });

  // ── View pipeline: Mine/All filter + synthetic deleted rows (client-side) ──
  const scoped = useMemo(() => {
    const all = allJobs ?? [];
    if (showAll) return all;
    const serverNames = new Set(all.map((j) => j.name));
    const mine = computeView(all, {
      filters: { tracked: (j: JobDTO) => trackedNames.has(j.name) },
      activeFilters: ["tracked"],
    });
    // Tracked-but-missing-on-server → synthetic placeholder rows. Only synthesize
    // for tracked names that live at the current folder level (parent path matches
    // currentFolder), so drilling into a folder doesn't surface root/sibling jobs.
    const deleted: JobDTO[] = [];
    for (const name of trackedNames) {
      const lastSlash = name.lastIndexOf("/");
      const parent = lastSlash >= 0 ? name.slice(0, lastSlash) : null;
      if (parent !== currentFolder) continue;
      if (!serverNames.has(name)) {
        deleted.push({
          id: name,
          name,
          url: "",
          color: "[DELETED_ON_SERVER]",
          buildable: false,
          lastBuildNumber: null,
          lastBuildUrl: null,
          description: "",
          jobClass: "",
          jobType: "",
        });
      }
    }
    return [...mine, ...deleted];
  }, [allJobs, showAll, trackedNames, currentFolder]);

  // Pre-compute lowercase search index once per scoped change (not per keystroke).
  // computeView's inner loop calls searchText(item).toLowerCase() for every item on
  // every query change — with 1000 jobs that's 1000 string allocs per keypress.
  // Indexing here moves that work out of the hot search path.
  const searchIndex = useMemo(
    () => scoped.map((j) => `${j.name} ${j.description ?? ""}`.toLowerCase()),
    [scoped],
  );

  // Then the "/" search filter (matches name + description), client-side.
  const jobs = useMemo(() => {
    const q = search.query.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter((_, i) => searchIndex[i]!.includes(q));
  }, [scoped, search.query, searchIndex]);

  // ── Stable cursor: keep selection on the same job across refresh/filter ──
  const rowKeys = useMemo(() => jobs.map((j) => j.name), [jobs]);
  const { cursor, setCursor } = useStableCursor(rowKeys);
  const current = jobs[cursor];

  // Pre-build DataTable cell rows once per jobs/trackedNames change.
  // With 1000+ jobs, jobs.map() inside JSX runs on every keystroke (cursor move
  // → re-render). Memoizing here means the 6000-cell array is only rebuilt when
  // the underlying data actually changes, not on navigation.
  type CellRow = { text: string; color?: string; dim?: boolean }[];
  const tableRows = useMemo<CellRow[]>(
    () =>
      jobs.map((j) => {
        const st = statusCell(j.color);
        const tp = typeLabel(j.jobType);
        const mine = trackedNames.has(j.name);
        // Display only the leaf name (strip the folder prefix shown in the breadcrumb).
        const leaf = currentFolder && j.name.startsWith(`${currentFolder}/`)
          ? j.name.slice(currentFolder.length + 1)
          : j.name;
        // Folders get a trailing "/" + arrow so they read as drillable.
        const isFolderRow = isContainer(j.jobType);
        const nameText = isFolderRow ? `${leaf}/ ${SYM.arrow}` : leaf;
        return [
          { text: mine ? SYM.tracked : "", color: THEME.success },
          { text: st.text, color: st.color, dim: st.dim },
          { text: tp.text, color: tp.color, dim: (tp as { dim?: boolean }).dim },
          { text: nameText, color: isFolderRow ? THEME.yellow : undefined },
          { text: j.lastBuildNumber ? `#${j.lastBuildNumber}` : "—" },
          { text: j.description ?? "" },
        ];
      }),
    [jobs, trackedNames, currentFolder],
  );

  // Detail panel (config summary for the highlighted job).
  const [summary, setSummary] = useState<JobConfigSummary | null>(null);
  // Controlled-agent grants for the highlighted folder (FD type only).
  const [controlledAgents, setControlledAgents] = useState<ControlledAgentGrant[] | null>(null);

  // In-memory cache of config summaries: avoids re-fetching config.xml every
  // time the cursor moves back to a previously-visited job within the session.
  // Invalidated per-job after any update/create via invalidateSummary().
  const summaryCache = useRef<Map<string, JobConfigSummary>>(new Map());
  const invalidateSummary = useCallback((name: string) => {
    summaryCache.current.delete(name);
  }, []);

  // Fetch config summary for the highlighted job (detail panel).
  useEffect(() => {
    let cancelled = false;
    if (!current || !ctx.loggedIn || current.color === "[DELETED_ON_SERVER]") {
      setSummary(null);
      return;
    }
    // Serve from cache if available.
    const cached = summaryCache.current.get(current.name);
    if (cached) {
      setSummary(cached);
      return;
    }
    void (async () => {
      try {
        const client = await ctx.getClient({ useController: true });
        const s = await getJobConfigSummary(client, current.name);
        summaryCache.current.set(current.name, s);
        if (!cancelled) setSummary(s);
      } catch {
        if (!cancelled) setSummary(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx, current?.name]);

  // Fetch controlled-agent grants for FD folders.
  useEffect(() => {
    let cancelled = false;
    if (!current || current.jobType !== "FD" || !ctx.loggedIn) {
      setControlledAgents(null);
      return;
    }
    void (async () => {
      try {
        const client = await ctx.getClient({ useController: true });
        const grants = await listControlledAgents(client, current.name);
        if (!cancelled) setControlledAgents(grants);
      } catch {
        if (!cancelled) setControlledAgents(null);
      }
    })();
    return () => { cancelled = true; };
  }, [ctx, current?.name, current?.jobType]);

  // Controlled-agents overlay (FD only): fetch grants for the open folder.
  const fetchAgentGrants = useCallback(async (folder: string) => {
    setAgentGrantItems(null);
    try {
      const client = await ctx.getClient({ useController: true });
      const grants = await listControlledAgents(client, folder);
      setAgentGrantItems(
        grants.map((g) => ({
          label: g.agentName ?? "",
          id: g.grantId,
          pending: g.agentName === null,
        })),
      );
    } catch {
      setAgentGrantItems([]);
    }
  }, [ctx]);

  useEffect(() => {
    if (agentsFolder) void fetchAgentGrants(agentsFolder);
    else setAgentGrantItems(null);
  }, [agentsFolder, fetchAgentGrants]);

  const doAddAgentGrant = useCallback(async () => {
    if (!agentsFolder) return;
    const result = await ctx.openModal<Record<string, string>>({
      id: "approve-agent-input",
      render: (resolve) => (
        <FormModal
          title={`${SYM.gear} Approve Agent for '${agentsFolder}'`}
          fields={[{ name: "agent", label: "Agent Name", required: true, hint: "controlled agent to approve" }]}
          onResult={resolve}
        />
      ),
    });
    if (!result?.agent) return;
    try {
      const client = await ctx.getClient({ useController: true });
      await approveAgentForFolder(client, agentsFolder, result.agent);
      ctx.notify(`${SYM.ok} Agent '${result.agent}' approved for '${agentsFolder}'`, "success");
      ctx.logCommand(`bee job approve-agent ${agentsFolder} ${result.agent}`);
      void fetchAgentGrants(agentsFolder);
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [agentsFolder, ctx, fetchAgentGrants]);

  const doRevokeAgentGrant = useCallback(async (item: GrantItem) => {
    if (!agentsFolder) return;
    const ok = await ctx.openModal<boolean>({
      id: "revoke-agent-confirm",
      render: (resolve) => (
        <ConfirmModal
          message={`Revoke agent '${item.label}' from folder '${agentsFolder}'?`}
          onResult={resolve}
        />
      ),
    });
    if (!ok) return;
    try {
      const client = await ctx.getClient({ useController: true });
      await removeControlledAgentGrant(client, agentsFolder, item.id);
      ctx.notify(`${SYM.ok} Agent removed from '${agentsFolder}'`, "success");
      ctx.logCommand(`bee job remove-agent ${agentsFolder} ${item.label}`);
      void fetchAgentGrants(agentsFolder);
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [agentsFolder, ctx, fetchAgentGrants]);

  const runJob = useCallback(
    async (name: string): Promise<false | void> => {
      const paramDefs = summary?.params ?? [];
      let runParams: Record<string, string> | null = null;

      if (paramDefs.length > 0) {
        const values = await ctx.openModal<Record<string, string>>({
          id: "run-params",
          render: (resolve) => (
            <FormModal
              title={`${SYM.gear} Run '${name}' — Parameters`}
              fields={paramDefs.map((p) => ({
                name: p.name,
                label: p.name,
                initial: p.defaultValue ?? "",
              }))}
              onResult={resolve}
            />
          ),
        });
        if (!values) return false;
        runParams = values;
      } else {
        const ok = await ctx.openModal<boolean>({
          id: "confirm-run",
          render: (resolve) => <ConfirmModal message={`Run job '${name}'?`} onResult={resolve} />,
        });
        if (!ok) return false;
      }

      try {
        const client = await ctx.getClient({ useController: true });
        if (runParams) {
          await triggerJobWithParams(client, name, runParams);
          const pairs = Object.entries(runParams).map(([k, v]) => `-p ${k}="${v}"`).join(" ");
          ctx.logCommand(`bee job run ${name} ${pairs}`);
        } else {
          await triggerJob(client, name);
          ctx.logCommand(`bee job run ${name}`);
        }
        ctx.notify(`${SYM.ok} Triggered: ${name}`, "success");
        void refetch();
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [ctx, refetch, summary],
  );

  const stopJob = useCallback(
    async (job: JobDTO): Promise<false | void> => {
      if (!job.lastBuildNumber) {
        ctx.notify("No builds found to stop.", "warning");
        return false;
      }
      const ok = await ctx.openModal<boolean>({
        id: "confirm-stop",
        render: (resolve) => (
          <ConfirmModal message={`Stop build #${job.lastBuildNumber} of '${job.name}'?`} onResult={resolve} />
        ),
      });
      if (!ok) return false;
      try {
        const client = await ctx.getClient({ useController: true });
        await stopBuild(client, job.name, job.lastBuildNumber);
        ctx.notify(`${SYM.ok} Stopped build #${job.lastBuildNumber}`, "success");
        ctx.logCommand(`bee job stop ${job.name} ${job.lastBuildNumber}`);
        void refetch();
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [ctx, refetch],
  );

  const removeJob = useCallback(
    async (name: string): Promise<false | void> => {
      const ok = await ctx.openModal<boolean>({
        id: "confirm-delete",
        render: (resolve) => (
          <ConfirmModal message={`Delete job '${name}'? This cannot be undone.`} onResult={resolve} />
        ),
      });
      if (!ok) return false;
      try {
        const client = await ctx.getClient({ useController: true });
        await deleteJob(client, name);
        untrackResource("job", name, ctx.profile, client.baseUrl, ctx.dbPath);
        ctx.notify(`${SYM.ok} Deleted: ${name}`, "success");
        ctx.logCommand(`bee job delete ${name} --yes`);
        void refetch();
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [ctx, refetch],
  );

  const newJob = useCallback(async () => {
    const result = await ctx.openModal<Record<string, string>>({
      id: "create-job",
      render: (resolve) => (
        <FormModal
          title={`${SYM.gear} Create New Job${currentFolder ? ` in /${currentFolder}` : ""}`}
          fields={[
            { name: "name", label: "Job Name", required: true, hint: "unique id" },
            { name: "job_type", label: "Type", options: ["freestyle", "folder"], initial: "freestyle", hint: "freestyle/folder" },
            { name: "desc", label: "Description" },
            { name: "shell_cmd", label: "Shell Command", placeholder: "freestyle only", hint: "shell to run" },
            { name: "chdir", label: "Working Dir", placeholder: "cd <dir> && before command", path: true, hint: "Tab completes local FS" },
            { name: "node", label: "Node/Label", options: nodeOptions, searchable: true, initial: NONE_OPTION, hint: "where it runs" },
          ]}
          onResult={resolve}
        />
      ),
    });
    if (!result || !result.name) return;
    try {
      const client = await ctx.getClient({ useController: true });
      const jobType = (result.job_type || "freestyle").toLowerCase();
      // Qualified name = folder path + leaf, used for tracking + command log.
      const qualified = currentFolder ? `${currentFolder}/${result.name}` : result.name;
      if (jobType === "folder") {
        await createFolder(client, result.name, result.desc ?? "", currentFolder);
      } else {
        await createFreestyleJob(client, result.name, {
            desc: result.desc ?? "",
            shellCmd: result.shell_cmd || "echo hello",
            chdir: result.chdir || null,
            node: result.node && result.node !== NONE_OPTION ? result.node : null,
          }, currentFolder);
      }
      trackResource("job", qualified, ctx.profile, client.baseUrl, ctx.dbPath);
      if (jobType === "freestyle" && (!result.node || result.node === NONE_OPTION)) {
        ctx.notify(`${SYM.warn} Job created with no node assigned — will run on any available agent`, "warning");
      } else {
        ctx.notify(`${SYM.ok} Created ${jobType}: ${qualified}`, "success");
      }
      const leaf = currentFolder ? qualified.slice(currentFolder.length + 1) : qualified;
      ctx.logCommand(jobType === "folder"
        ? `bee job create folder ${leaf}${currentFolder ? ` --folder "${currentFolder}"` : ""}${result.desc ? ` --description "${result.desc}"` : ""}`
        : `bee job create freestyle ${leaf}${currentFolder ? ` --folder "${currentFolder}"` : ""}${result.desc ? ` --description "${result.desc}"` : ""}${result.shell_cmd ? ` --shell "${result.shell_cmd}"` : ""}${result.node && result.node !== NONE_OPTION ? ` --node "${result.node}"` : ""}`);
      void refetch();
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [ctx, refetch, currentFolder]);

  const editJob = useCallback(
    async (job: JobDTO): Promise<false | void> => {
      const s = summary;
      const result = await ctx.openModal<Record<string, string>>({
        id: "edit-job",
        render: (resolve) => (
          <FormModal
            title={`${SYM.gear} Edit Job: ${job.name}`}
            fields={[
              { name: "desc", label: "Description", initial: s?.description || job.description || "", hint: "free text" },
              { name: "shell_cmd", label: "Shell Command", initial: s?.shell_cmd || "", hint: "shell to run" },
              { name: "chdir", label: "Working Dir", initial: s?.chdir || "", path: true, hint: "Tab completes local FS" },
              { name: "node", label: "Node/Label", options: nodeOptions, searchable: true, initial: s?.node && s.node !== "-" ? s.node : NONE_OPTION, hint: "where it runs" },
            ]}
            onResult={resolve}
          />
        ),
      });
      if (!result) return false;
      try {
        const client = await ctx.getClient({ useController: true });
        const finalShell = result.shell_cmd
          ? (result.chdir ? `cd ${result.chdir} && ${result.shell_cmd}` : result.shell_cmd)
          : null;
        await updateJobFreestyle(
          client,
          job.name,
          {
            desc: result.desc ?? null,
            shellCmd: finalShell,
            node: result.node && result.node !== NONE_OPTION ? result.node : null,
          },
        );
        ctx.notify(`${SYM.ok} Updated: ${job.name}`, "success");
        if (result.node === NONE_OPTION) {
          ctx.notify(`${SYM.warn} Job has no node assigned — will run on any available agent`, "warning");
        }
        invalidateSummary(job.name);
        const initDesc = s?.description || job.description || "";
        const initShell = s?.shell_cmd || "";
        const initChdir = s?.chdir || "";
        const initNode = s?.node && s.node !== "-" ? s.node : NONE_OPTION;
        const parts = [`bee job update freestyle ${job.name}`];
        if (result.desc !== initDesc) parts.push(`--description "${result.desc}"`);
        if (result.shell_cmd !== initShell || result.chdir !== initChdir) {
          if (finalShell) parts.push(`--shell "${finalShell}"`);
        }
        if (result.node !== initNode) {
          parts.push(result.node !== NONE_OPTION ? `--node "${result.node}"` : `--node ""`);
        }
        ctx.logCommand(parts.join(" "));
        void refetch();
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [ctx, refetch, summary, invalidateSummary],
  );

  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const bulkRemoveJobs = useCallback(async (): Promise<false | void> => {
    const targets = selected.size > 0
      ? [...selected]
      : current ? [current.name] : [];
    if (targets.length === 0) return false;
    const preview = targets.slice(0, 5).join(", ");
    const suffix = targets.length > 5 ? `, +${targets.length - 5} more` : "";
    const msg = targets.length === 1
      ? `Delete job '${targets[0]}'? This cannot be undone.`
      : `Delete ${targets.length} jobs: ${preview}${suffix}\n\nThis cannot be undone.`;
    const ok = await ctx.openModal<boolean>({
      id: "confirm-bulk-delete-jobs",
      render: (resolve) => <ConfirmModal message={msg} onResult={resolve} />,
    });
    if (!ok) return false;
    const client = await ctx.getClient({ useController: true });
    let deletedCount = 0;
    for (const name of targets) {
      try {
        await deleteJob(client, name);
        untrackResource("job", name, ctx.profile, client.baseUrl, ctx.dbPath);
        deletedCount++;
      } catch (err) {
        ctx.notify(`Failed: ${name} — ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }
    setSelected(new Set());
    if (deletedCount > 0) {
      ctx.notify(`${SYM.ok} Deleted ${deletedCount} job(s)`, "success");
      ctx.logCommand(targets.map((n) => `bee job delete ${n} --yes`).join("\n"));
      void refetch();
    }
  }, [selected, current, ctx, refetch]);

  // Clone the cursor job into the current folder under a new name.
  const cloneJob = useCallback(async (): Promise<false | void> => {
    if (!current) return false;
    const src = current.name;
    const leaf = currentFolder && src.startsWith(`${currentFolder}/`)
      ? src.slice(currentFolder.length + 1)
      : src;
    const result = await ctx.openModal<Record<string, string>>({
      id: "clone-job",
      render: (resolve) => (
        <FormModal
          title={`${SYM.gear} Clone '${leaf}'${currentFolder ? ` in /${currentFolder}` : ""}`}
          fields={[
            { name: "name", label: "New Name", required: true, initial: `${leaf}-copy`, hint: "unique id" },
          ]}
          onResult={resolve}
        />
      ),
    });
    if (!result || !result.name) return false;
    try {
      const client = await ctx.getClient({ useController: true });
      await copyJob(client, src, result.name, currentFolder);
      const qualified = currentFolder ? `${currentFolder}/${result.name}` : result.name;
      trackResource("job", qualified, ctx.profile, client.baseUrl, ctx.dbPath);
      ctx.notify(`${SYM.ok} Cloned '${leaf}' → '${result.name}'`, "success");
      ctx.logCommand(`bee job copy ${src} ${qualified}`);
      void refetch();
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
    return false;
  }, [current, currentFolder, ctx, refetch]);

  // Bulk import/unimport the selected rows (multi-select only; no-op when empty).
  const bulkImport = useCallback((): void => {
    if (!baseUrl || selected.size === 0) return;
    const toAdd = [...selected].filter((n) => !trackedNames.has(n));
    if (toAdd.length === 0) {
      ctx.notify(`${SYM.warn} Nothing to import — all selected already in Mine`, "warning");
      return;
    }
    for (const name of toAdd) trackResource("job", name, ctx.profile, baseUrl, ctx.dbPath);
    setSelected(new Set());
    ctx.notify(`${SYM.ok} Imported ${toAdd.length} job(s) into Mine`, "success");
    ctx.logCommand(toAdd.map((n) => `bee job import ${n}`).join("\n"));
    void refetch();
  }, [baseUrl, selected, trackedNames, ctx, refetch]);

  const bulkUnimport = useCallback((): void => {
    if (!baseUrl || selected.size === 0) return;
    const toRemove = [...selected].filter((n) => trackedNames.has(n));
    if (toRemove.length === 0) {
      ctx.notify(`${SYM.warn} Nothing to unimport — none selected are in Mine`, "warning");
      return;
    }
    for (const name of toRemove) untrackResource("job", name, ctx.profile, baseUrl, ctx.dbPath);
    setSelected(new Set());
    ctx.notify(`${SYM.ok} Removed ${toRemove.length} job(s) from Mine`, "success");
    ctx.logCommand(toRemove.map((n) => `bee job unimport ${n}`).join("\n"));
    void refetch();
  }, [baseUrl, selected, trackedNames, ctx, refetch]);

  // Folder navigation: Enter on a folder row descends into it; Backspace pops
  // back up one level. The cursor/selection reset on level change so the user
  // starts at the top of the new listing.
  const isFolder = current !== undefined && isContainer(current.jobType);
  const drillIn = useCallback((folderName: string) => {
    setFolderStack((prev) => [...prev, folderName]);
    setSelected(new Set());
    setCursor(0);
  }, [setCursor]);
  const goUp = useCallback(() => {
    setFolderStack((prev) => prev.slice(0, -1));
    setSelected(new Set());
    setCursor(0);
  }, [setCursor]);

  // Declarative keymap — the single source for both dispatch and footer hints.
  // `F` (not `f`) toggles auto-refresh so it can't collide with the table's
  // Ctrl+f paging.
  const menuActions = useMemo(
    () => [
      // Every action returns false so menuOpen stays true. Overlay actions
      // (ViewLog/Params/Schedule/Email) set their own state, which early-returns
      // the overlay ahead of the menu render; closing the overlay re-renders with
      // menuOpen still set, so Esc lands back on the menu, not the bare list.
      { label: "View Log",   icon: SYM.iconLog,      run: () => { if (current) setLogJob(current.name); return false as const; } },
      { label: "Run",        icon: SYM.iconPlay,      run: async () => { if (!current) return false as const; return await runJob(current.name); } },
      { label: "Stop",       icon: SYM.iconStop,      run: async () => { if (!current) return false as const; return await stopJob(current); } },
      { label: "Edit",       icon: SYM.iconEdit,      run: async () => { if (!current) return false as const; return await editJob(current); } },
      { label: "Params",     icon: SYM.iconParams,    run: () => { if (current) setParamJob(current.name); return false as const; } },
      { label: "Schedule",   icon: SYM.iconSchedule,  run: () => { if (current) setScheduleJob({ name: current.name, cron: (summary?.schedule && summary.schedule !== "-") ? summary.schedule : "" }); return false as const; } },
      { label: "Email",      icon: SYM.iconEmail,     run: () => {
        if (!current) return false as const;
        const s = summary;
        const hasEmail = s?.email && s.email !== "-";
        setEmailJob({
          name: current.name,
          spec: {
            enabled: !!hasEmail,
            email: hasEmail ? s!.email : "",
            emailCond: (s?.email_cond && s.email_cond !== "-") ? s.email_cond : "failed",
            emailKeywords: (s?.email_keywords && s.email_keywords !== "-") ? s.email_keywords : "",
            emailRegex: (s?.email_regex && s.email_regex !== "-") ? s.email_regex : "",
          },
        });
        return false as const;
      } },
      { label: "Delete",     icon: SYM.iconDelete,    danger: true, run: async (): Promise<false | void> => { if (!current) return false; await removeJob(current.name); } },
      { label: "Controlled Agents", icon: SYM.iconSchedule, when: () => current?.jobType === "FD", run: (): false => {
        if (!current) return false;
        setAgentsFolder(current.name);
        return false;
      } },
    ],
    [current, summary, runJob, stopJob, editJob, removeJob],
  );

  // Multi-select mode: when rows are checked via Space, the footer collapses to
  // the bulk actions (import/unimport/delete/clear) and hides single-row hints
  // so the user only sees what applies to the selection.
  const multi = selected.size > 0;
  const bindings = useMemo<KeyBinding[]>(
    () => [
      // Enter drills into a container (FD/MB) or opens the action menu for a
      // Freestyle leaf. Other leaf types (Pipeline, etc.) aren't supported yet,
      // so refuse with a notice instead of opening an FS-only menu.
      { key: "Enter", label: isFolder ? "open" : current?.jobType === "FS" ? "menu" : "n/a", group: "action", hidden: multi, when: () => !multi && current !== undefined && !menuOpen, run: () => {
        if (!current) return;
        if (isFolder) { drillIn(current.name); return; }
        if (current.jobType === "FS") { setMenuOpen(true); return; }
        const cls = current.jobClass ? current.jobClass.split(".").at(-1)! : current.jobType;
        ctx.notify(`${SYM.warn} ${cls} isn't supported yet — only Freestyle and Folder.`, "warning");
      } },
      { key: "backspace", label: "up", group: "nav", hidden: multi, when: () => !multi && folderStack.length > 0, run: () => goUp() },
      { key: "ctrl+d", label: "delete", group: "action",
        when: () => (multi || current !== undefined) && !menuOpen,
        run: () => void bulkRemoveJobs() },
      { key: "ctrl+n", label: "new", hidden: multi, when: () => !multi, run: () => void newJob() },
      { key: "c", label: "clone", group: "action", hidden: multi, when: () => !multi && current?.jobType === "FS" && !menuOpen, run: () => void cloneJob() },
      { key: "i", label: "import", group: "action", hidden: !multi,
        when: () => multi && !menuOpen, run: () => bulkImport() },
      { key: "u", label: "unimport", group: "action", hidden: !multi,
        when: () => multi && !menuOpen, run: () => bulkUnimport() },
      { key: "A", label: "agents", group: "action", hidden: multi || current?.jobType !== "FD", when: () => !multi && current?.jobType === "FD" && !menuOpen, run: (): false => {
        if (!current) return false;
        setAgentsFolder(current.name);
        return false;
      } },
      { key: "ctrl+a", label: "mine/all", hidden: multi, when: () => !multi, run: () => setShowAll((v) => { const nv = !v; setScopeShowAll("job", nv, ctx.dbPath); return nv; }) },
      { key: "F", label: "auto", hidden: multi, when: () => !multi, run: () => setAutoRefresh((v) => !v) },
      search.openBinding,
      { key: "Esc", label: "clear", group: "action", hidden: !multi && !search.active,
        when: () => multi || search.active,
        run: () => { if (multi) setSelected(new Set()); else search.clear(); } },
      { key: "r", label: "refresh", hidden: multi, when: () => !multi, run: () => void refetch() },
    ],
    [current, menuOpen, selected, multi, bulkRemoveJobs, newJob, cloneJob, bulkImport, bulkUnimport, isFolder, drillIn, goUp, folderStack, search, refetch, ctx],
  );

  // While typing in the search box, the search hook owns input — suspend the
  // action keymap (and the table's nav) so letters don't trigger actions.
  useKeymap(bindings, { isActive: active && !logJob && !paramJob && !scheduleJob && !emailJob && !menuOpen && !agentsFolder && !search.editing });

  useEffect(() => {
    if (!active) return;
    if (logJob || paramJob || scheduleJob || emailJob || menuOpen || agentsFolder) ctx.setActiveKeyHints([]);
    else ctx.setActiveKeyHints(bindingsToHints(bindings));
  }, [active, logJob, paramJob, scheduleJob, emailJob, menuOpen, agentsFolder, bindings, ctx]);

  if (agentsFolder) {
    return (
      <GrantListOverlay
        title={`Controlled Agents — ${agentsFolder}`}
        subtitle="Agents approved to run builds from this folder"
        itemHeader="Agent"
        items={agentGrantItems}
        emptyText="No controlled-agent grants (Folders Plus may not be installed)."
        addHint="approve agent"
        onAdd={() => void doAddAgentGrant()}
        onRevoke={(item) => void doRevokeAgentGrant(item)}
        onRefresh={() => void fetchAgentGrants(agentsFolder)}
        onClose={() => { setAgentsFolder(null); setMenuOpen(false); }}
        isActive={!ctx.modalActive}
      />
    );
  }

  if (logJob) {
    return <LogViewer ctx={ctx} jobName={logJob} onClose={() => setLogJob(null)} />;
  }

  if (paramJob) {
    return (
      <ParamListEditor
        initial={summary?.params ?? []}
        setInputCaptured={ctx.setInputCaptured}
        onResult={(params) => {
          const name = paramJob;
          setParamJob(null);
          if (!params) return;
          void (async () => {
            try {
              const client = await ctx.getClient({ useController: true });
              await updateJobFreestyle(
                client, name,
                {
                  params,
                  clearParams: params.length === 0,
                },
              );
              ctx.notify(`${SYM.ok} Updated parameters: ${name}`, "success");
              invalidateSummary(name);
              if (params.length === 0) {
                ctx.logCommand(`bee job update freestyle ${name} --clear-params`);
              } else {
                const pp = [`bee job update freestyle ${name}`];
                for (const p of params) {
                  pp.push(`--param-def "${p.name}=${p.defaultValue ?? ""}"`);
                }
                ctx.logCommand(pp.join(" "));
              }
              void refetch();
            } catch (err) {
              ctx.notify(err instanceof Error ? err.message : String(err), "error");
            }
          })();
        }}
      />
    );
  }

  if (scheduleJob) {
    return (
      <ScheduleBuilder
        initial={parseCron(scheduleJob.cron)}
        jobName={scheduleJob.name}
        setInputCaptured={ctx.setInputCaptured}
        onResult={(cron) => {
          const name = scheduleJob.name;
          setScheduleJob(null);
          if (cron === null) return; // cancelled
          void (async () => {
            try {
              const client = await ctx.getClient({ useController: true });
              // schedule "" removes the trigger; updateJobFreestyle treats the
              // schedule arg as: null = unchanged, "" = clear, value = set.
              await updateJobFreestyle(client, name, { schedule: cron });
              ctx.notify(`${SYM.ok} Updated schedule: ${name}`, "success");
              invalidateSummary(name);
              ctx.logCommand(cron
                ? `bee job update freestyle ${name} --schedule "${cron}"`
                : `bee job update freestyle ${name} --schedule ""`
              );
              void refetch();
            } catch (err) {
              ctx.notify(err instanceof Error ? err.message : String(err), "error");
            }
          })();
        }}
      />
    );
  }

  if (emailJob) {
    return (
      <EmailBuilder
        initial={emailJob.spec}
        groovyAvailable={emailExtAvailable}
        setInputCaptured={ctx.setInputCaptured}
        onResult={(spec) => {
          const name = emailJob.name;
          setEmailJob(null);
          if (!spec) return;
          void (async () => {
            try {
              const client = await ctx.getClient({ useController: true });
              if (!spec.enabled) {
                // Clear email by setting recipient to empty string.
                await updateJobFreestyle(
                  client, name,
                  { email: "", clearEmailKeywords: true, clearEmailRegex: true },
                );
              } else {
                const keywords = spec.emailKeywords
                  ? spec.emailKeywords.split(",").map((k) => k.trim()).filter(Boolean)
                  : null;
                await updateJobFreestyle(
                  client, name,
                  {
                    email: spec.email || null,
                    emailCond: spec.emailCond || null,
                    emailKeywords: keywords,
                    emailRegex: spec.emailRegex || null,
                    clearEmailKeywords: !spec.emailKeywords,
                    clearEmailRegex: !spec.emailRegex,
                  },
                );
              }
              ctx.notify(`${SYM.ok} Updated email: ${name}`, "success");
              invalidateSummary(name);
              if (!spec.enabled) {
                ctx.logCommand(`bee job update freestyle ${name} --email ""`);
              } else {
                const ep = [`bee job update freestyle ${name}`];
                if (spec.email) ep.push(`--email "${spec.email}"`);
                if (spec.emailCond) ep.push(`--email-cond "${spec.emailCond}"`);
                // --email-keyword is repeatable (one flag per keyword), matching CLI behaviour.
                if (spec.emailKeywords) {
                  for (const kw of spec.emailKeywords.split(",").map((k) => k.trim()).filter(Boolean)) {
                    ep.push(`--email-keyword "${kw}"`);
                  }
                }
                if (spec.emailRegex) ep.push(`--email-regex "${spec.emailRegex}"`);
                ctx.logCommand(ep.join(" "));
              }
              void refetch();
            } catch (err) {
              ctx.notify(err instanceof Error ? err.message : String(err), "error");
            }
          })();
        }}
      />
    );
  }

  if (menuOpen && current) {
    return (
      <ContextMenu
        title={`Job: ${current.name}`}
        actions={menuActions}
        isActive={!ctx.modalActive}
        onClose={() => setMenuOpen(false)}
      />
    );
  }

  // Not-logged-in is a distinct, friendly state rather than an error.
  const notLoggedIn = !ctx.loggedIn;
  const noController = ctx.loggedIn && !ctx.activeController;
  const errMsg = error ? error.message : "";

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* ── Compact header ── */}
      <Box>
        <Text color={THEME.dim}>{SYM.gear} Jobs  </Text>
        {showAll
          ? <Text color={THEME.yellow} bold>[ALL]</Text>
          : <Text color={THEME.success} bold>[MINE]</Text>}
        {folderStack.length > 0 ? (
          <Text color={THEME.yellow}>  {SYM.arrow} /{folderStack.join("/")}</Text>
        ) : null}
        {autoRefresh ? <Text color={THEME.success}>  [auto]</Text> : null}
        {multi ? <Text color={THEME.active}>  [{selected.size} selected]</Text> : null}
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
          <Spinner label="Loading jobs…" />
        </Box>
      ) : errMsg && jobs.length === 0 ? (
        <Box marginTop={1}>
          <Text color={THEME.error}>
            {SYM.fail} {errMsg}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {/* A non-fatal error while stale data is still shown. */}
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
              { header: "Status", width: 12 },
              { header: "T", width: 3 },
              { header: "Name", width: 42, flex: true },
              { header: "Build #", width: 9 },
              { header: "Description", width: 30, flex: true },
            ]}
            rows={tableRows}
            rowKeys={rowKeys}
            cursor={cursor}
            onCursorChange={setCursor}
            active={active && !search.editing}
            emptyText="No jobs. Press Ctrl+n to create one."
            selected={selected}
            onToggleSelect={toggleSelect}
          />

          {/* Detail panel */}
          {current && (
            <Box flexDirection="column" borderStyle={borderStyle()} paddingX={1} marginTop={1}>
              {/* Title row */}
              <Box>
                <Text bold color={THEME.normal}>{current.name}</Text>
                {current.lastBuildNumber
                  ? <Text color={THEME.dim}>{"  "}#{current.lastBuildNumber}</Text>
                  : null}
              </Box>
              {/* Fields row */}
              <Box marginTop={0}>
                <Text color={THEME.dim}>type </Text>
                <Text color={THEME.blue}>{current.jobType || "—"}</Text>
                {summary?.schedule && summary.schedule !== "-" && (
                  <>
                    <Text color={THEME.subtle}>{"   "}</Text>
                    <Text color={THEME.dim}>schedule </Text>
                    <Text color={THEME.normal}>{summary.schedule}</Text>
                  </>
                )}
                {summary?.node && summary.node !== "-" && (
                  <>
                    <Text color={THEME.subtle}>{"   "}</Text>
                    <Text color={THEME.dim}>node </Text>
                    <Text color={THEME.normal}>{summary.node}</Text>
                  </>
                )}
                {summary?.email && summary.email !== "-" && (
                  <>
                    <Text color={THEME.subtle}>{"   "}</Text>
                    <Text color={THEME.dim}>email </Text>
                    <Text color={THEME.normal}>{summary.email}</Text>
                  </>
                )}
              </Box>
              {current.url && (
                <Text color={THEME.subtle} wrap="truncate-end">{current.url}</Text>
              )}
              {/* Controlled agents — FD folders only */}
              {current.jobType === "FD" && controlledAgents !== null && controlledAgents.length > 0 && (
                <Box marginTop={0}>
                  <Text color={THEME.dim}>controlled agents </Text>
                  <Text color={THEME.normal}>
                    {controlledAgents.map((g) => g.agentName ?? "(unassigned)").join(", ")}
                  </Text>
                </Box>
              )}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};

/** The plugin's TUI screen descriptor. */
export function jobScreen(): TuiScreen {
  return {
    id: "jobs",
    title: "Jobs",
    order: 4,
    icon: SYM.gear,
    Component: JobsScreen,
  };
}
