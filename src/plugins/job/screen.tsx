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
  getJobConfigSummary,
  triggerJob,
  stopBuild,
  deleteJob,
  createFreestyleJob,
  createFolder,
  streamLastBuildLog,
  updateJobFreestyle,
} from "./service";
import { getTrackedResources, trackResource, untrackResource } from "../../core/db/repositories/resource-repo";
import { getScopeShowAll, setScopeShowAll } from "../../core/db/repositories/scope-repo";
import { useMineOptions, NONE_OPTION } from "../../core/tui/data/use-mine-options";
import { listNodes } from "../node/service";
import { ScheduleBuilder } from "../../core/tui/components/ScheduleBuilder";
import { EmailBuilder, type EmailSpec } from "../../core/tui/components/EmailBuilder";
import { parseCron } from "../../domain/schedule";

// ─── Status + type rendering (port of _status_markup / _type_label) ─────────

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

function typeLabel(jobType: string | undefined): { text: string; color?: string } {
  const t = (jobType ?? "").toLowerCase();
  if (t.includes("pl") || t.includes("pipeline")) return { text: "PL", color: THEME.blue };
  if (t.includes("fs") || t.includes("freestyle")) return { text: "FS", color: "cyan" };
  if (t.includes("fd") || t.includes("folder")) return { text: "FD", color: THEME.yellow };
  if (t.includes("wf") || t.includes("workflow")) return { text: "WF", color: THEME.blue };
  return { text: "--", dim: true } as { text: string; color?: string };
}

// ─── Log viewer overlay (port of log_screen.py streaming) ────────────────────

interface LogViewerProps {
  ctx: TuiContext;
  jobName: string;
  onClose: () => void;
}

const POLL_MS = 2000;

const LogViewer: FC<LogViewerProps> = ({ ctx, jobName, onClose }) => {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState("connecting…");
  const offsetRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  const getClientRef = useRef(ctx.getClient);
  getClientRef.current = ctx.getClient;
  const { rows: termRows } = useDimensions();

  // This overlay owns input while open: tell the shell to suspend its global
  // keys so `q`/`b`/`Esc` close the log instead of quitting the whole app.
  useEffect(() => {
    ctx.setInputCaptured(true);
    return () => ctx.setInputCaptured(false);
  }, [ctx]);

  useKeymap(
    [
      { key: "q", label: "back", run: onClose },
      { key: "b", label: "back", run: onClose, hidden: true },
      { key: "Esc", label: "back", run: onClose, hidden: true },
    ],
    { isActive: true },
  );

  useEffect(() => {
    cancelledRef.current = false;

    const poll = async () => {
      if (cancelledRef.current) return;
      try {
        const client = await getClientRef.current({ useController: true });
        const [text, newOffset, hasMore] = await streamLastBuildLog(client, jobName, offsetRef.current);
        if (cancelledRef.current) return;
        if (text) {
          // One state update for the whole chunk (ring-buffer capped) — not one
          // write per line as the legacy did (P5).
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
        if (cancelledRef.current) return;
        setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    void poll();

    return () => {
      cancelledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [jobName]);

  // Show only the tail that fits the real terminal height. Reserve rows for the
  // app header/footer/toast chrome + this viewer's own title line and borders.
  const logRows = Math.max(5, termRows - 12);
  const visible = lines.slice(-logRows);

  return (
    <Box flexDirection="column" borderStyle={borderStyle()} paddingX={1} height={termRows - 8}>
      <Text>
        {SYM.arrow} Log: <Text bold>{jobName}</Text>{" "}
        <Text color={THEME.dim}>
          [{status}] · q/Esc=back
        </Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 ? (
          <Text color={THEME.dim}>(no output yet)</Text>
        ) : (
          visible.map((line, i) => (
            <Text key={i} color={colorForLine(line)} wrap="truncate-end">
              {line || " "}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
};

// ─── Jobs screen ─────────────────────────────────────────────────────────────

const JobsScreen: FC<TuiScreenProps> = ({ ctx, active }) => {
  // Mine/All is now a pure client-side filter — no refetch on toggle (P6).
  // Initial scope is persisted per resource-type (Q10).
  const [showAll, setShowAll] = useState(() => getScopeShowAll("job", ctx.dbPath));
  // Live terminal width for auto-scaling the table (Q4).
  const { columns: termCols } = useDimensions();
  // Opt-in auto-refresh (legacy P13): OFF by default, toggled with `f`.
  const [autoRefresh, setAutoRefresh] = useState(false);
  // The screen's HTTP base url, captured once a client is available. Used both
  // as the resource cache key and for tracked-resource lookups.
  const [baseUrl, setBaseUrl] = useState<string | null>(null);

  // Overlays local to this tab.
  const [logJob, setLogJob] = useState<string | null>(null);
  // Job whose build parameters are being edited (ParamListEditor overlay).
  const [paramJob, setParamJob] = useState<string | null>(null);
  // Job whose schedule is being edited (ScheduleBuilder overlay). Holds the
  // job name + its current cron (so the builder prefills from it).
  const [scheduleJob, setScheduleJob] = useState<{ name: string; cron: string } | null>(null);
  // Job whose email config is being edited (EmailBuilder overlay).
  const [emailJob, setEmailJob] = useState<{ name: string; spec: EmailSpec } | null>(null);

  // Inline "/" search box (client-side filter; no refetch). Disabled while the
  // log overlay is open.
  const search = useSearch({ isActive: active && logJob === null && emailJob === null, onEditingChange: ctx.setInputCaptured });

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

  // ── Read pipeline: list jobs via the ResourceStore (TTL, dedup, stale) ──
  const cacheKey = `jobs.list.${baseUrl ?? "?"}`;
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
      return listJobs(client);
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
    // Tracked-but-missing-on-server → synthetic placeholder rows.
    const deleted: JobDTO[] = [];
    for (const name of trackedNames) {
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
  }, [allJobs, showAll, trackedNames]);

  // Then the "/" search filter (matches name + description), client-side.
  const jobs = useMemo(
    () =>
      computeView(scoped, {
        query: search.query,
        searchText: (j) => `${j.name} ${j.description ?? ""}`,
      }),
    [scoped, search.query],
  );

  // ── Stable cursor: keep selection on the same job across refresh/filter ──
  const rowKeys = useMemo(() => jobs.map((j) => j.name), [jobs]);
  const { cursor, setCursor } = useStableCursor(rowKeys);
  const current = jobs[cursor];

  // Detail panel (config summary for the highlighted job).
  const [summary, setSummary] = useState<Record<string, string> | null>(null);

  // Fetch config summary for the highlighted job (detail panel).
  useEffect(() => {
    let cancelled = false;
    if (!current || !ctx.loggedIn || current.color === "[DELETED_ON_SERVER]") {
      setSummary(null);
      return;
    }
    void (async () => {
      try {
        const client = await ctx.getClient({ useController: true });
        const s = await getJobConfigSummary(client, current.name);
        if (!cancelled) setSummary(s as unknown as Record<string, string>);
      } catch {
        if (!cancelled) setSummary(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx, current?.name]);

  const runJob = useCallback(
    async (name: string) => {
      const ok = await ctx.openModal<boolean>({
        id: "confirm-run",
        render: (resolve) => <ConfirmModal message={`Run job '${name}'?`} onResult={resolve} />,
      });
      if (!ok) return;
      try {
        const client = await ctx.getClient({ useController: true });
        await triggerJob(client, name);
        ctx.notify(`${SYM.ok} Triggered: ${name}`, "success");
        ctx.logCommand(`bee job run ${name}`);
        void refetch();
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [ctx, refetch],
  );

  const stopJob = useCallback(
    async (job: JobDTO) => {
      if (!job.lastBuildNumber) {
        ctx.notify("No builds found to stop.", "warning");
        return;
      }
      const ok = await ctx.openModal<boolean>({
        id: "confirm-stop",
        render: (resolve) => (
          <ConfirmModal message={`Stop build #${job.lastBuildNumber} of '${job.name}'?`} onResult={resolve} />
        ),
      });
      if (!ok) return;
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
    async (name: string) => {
      const ok = await ctx.openModal<boolean>({
        id: "confirm-delete",
        render: (resolve) => (
          <ConfirmModal message={`Delete job '${name}'? This cannot be undone.`} onResult={resolve} />
        ),
      });
      if (!ok) return;
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
          title={`${SYM.gear} Create New Job`}
          fields={[
            { name: "name", label: "Job Name", required: true, hint: "unique id" },
            { name: "job_type", label: "Type", options: ["freestyle", "folder"], initial: "freestyle", hint: "freestyle/folder" },
            { name: "desc", label: "Description" },
            { name: "shell_cmd", label: "Shell Command", placeholder: "freestyle only", hint: "shell to run" },
            { name: "chdir", label: "Working Dir", placeholder: "cd <dir> && before command", path: true, hint: "Tab completes local FS" },
            { name: "node", label: "Node/Label", options: nodeOptions, initial: NONE_OPTION, hint: "where it runs" },
          ]}
          onResult={resolve}
        />
      ),
    });
    if (!result || !result.name) return;
    try {
      const client = await ctx.getClient({ useController: true });
      const jobType = (result.job_type || "freestyle").toLowerCase();
      if (jobType === "folder") {
        await createFolder(client, result.name, result.desc ?? "");
      } else {
        await createFreestyleJob(
          client,
          result.name,
          result.desc ?? "",
          result.shell_cmd || "echo hello",
          result.chdir || null,
          result.node && result.node !== NONE_OPTION ? result.node : null,
          null, // schedule owned by `t` key
          null, // email owned by `m` key
          "failed",
          null,
          null,
        );
      }
      trackResource("job", result.name, ctx.profile, client.baseUrl, ctx.dbPath);
      ctx.notify(`${SYM.ok} Created ${jobType}: ${result.name}`, "success");
      ctx.logCommand(jobType === "folder"
        ? `bee job create folder ${result.name}${result.desc ? ` --description "${result.desc}"` : ""}`
        : `bee job create freestyle ${result.name}${result.desc ? ` --description "${result.desc}"` : ""}${result.shell_cmd ? ` --shell "${result.shell_cmd}"` : ""}${result.node && result.node !== "None" ? ` --node ${result.node}` : ""}`);
      void refetch();
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [ctx, refetch]);

  // Edit = update an existing job's config. Prefills from the detail-panel
  // summary already fetched for the highlighted row. Blank fields = unchanged
  // (updateJobFreestyle does a partial update). Shell command can't be read back
  // from the summary, so leaving it blank keeps the current command.
  const editJob = useCallback(
    async (job: JobDTO) => {
      const s = summary ?? {};
      const result = await ctx.openModal<Record<string, string>>({
        id: "edit-job",
        render: (resolve) => (
          <FormModal
            title={`${SYM.gear} Edit Job: ${job.name}`}
            fields={[
              { name: "desc", label: "Description", initial: s.description || job.description || "", hint: "free text" },
              { name: "shell_cmd", label: "Shell Command", initial: s.shell_cmd || "", hint: "shell to run" },
              { name: "chdir", label: "Working Dir", initial: s.chdir || "", path: true, hint: "Tab completes local FS" },
              { name: "node", label: "Node/Label", options: nodeOptions, initial: s.node && s.node !== "-" ? s.node : NONE_OPTION, hint: "where it runs" },
            ]}
            onResult={resolve}
          />
        ),
      });
      if (!result) return;
      try {
        const client = await ctx.getClient({ useController: true });
        // chdir folds into the shell command (updateJobFreestyle has no chdir
        // param). Only compose when shell_cmd is set; otherwise pass null = unchanged.
        const finalShell = result.shell_cmd
          ? (result.chdir ? `cd ${result.chdir} && ${result.shell_cmd}` : result.shell_cmd)
          : null;
        await updateJobFreestyle(
          client,
          job.name,
          result.desc ?? null,
          finalShell,
          result.node && result.node !== NONE_OPTION ? result.node : null,
        );
        ctx.notify(`${SYM.ok} Updated: ${job.name}`, "success");
        ctx.logCommand(`bee job update ${job.name}`);
        void refetch();
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [ctx, refetch, summary],
  );

  // Import = track an existing server job into Mine (for jobs created outside bee).
  const doImport = useCallback(
    (name: string) => {
      if (!baseUrl) return;
      trackResource("job", name, ctx.profile, baseUrl, ctx.dbPath);
      ctx.notify(`${SYM.ok} Imported '${name}' into Mine`, "success");
      ctx.logCommand(`bee job import ${name}`);
      void refetch();
    },
    [baseUrl, ctx, refetch],
  );

  // Declarative keymap — the single source for both dispatch and footer hints.
  // `F` (not `f`) toggles auto-refresh so it can't collide with the table's
  // Ctrl+f paging.
  const hasRow = current !== undefined && current.color !== "[DELETED_ON_SERVER]";
  // Importable = a real server row not yet in the Mine list (most useful in All view).
  const canImport = hasRow && current !== undefined && !trackedNames.has(current.name);
  // Untrackable = a row already in Mine (inverse of import).
  const canUntrack = hasRow && current !== undefined && trackedNames.has(current.name);
  const bindings = useMemo<KeyBinding[]>(
    () => [
      { key: "Enter", label: "log", group: "action", when: () => current !== undefined, run: () => { if (current) setLogJob(current.name); } },
      { key: "r", label: "run", when: () => hasRow, run: () => { if (current) void runJob(current.name); } },
      { key: "s", label: "stop", when: () => hasRow, run: () => { if (current) void stopJob(current); } },
      { key: "l", label: "log", hidden: true, when: () => current !== undefined, run: () => { if (current) setLogJob(current.name); } },
      { key: "n", label: "new", run: () => void newJob() },
      { key: "e", label: "edit", when: () => hasRow, run: () => { if (current) void editJob(current); } },
      { key: "p", label: "params", when: () => hasRow, run: () => { if (current) setParamJob(current.name); } },
      { key: "t", label: "schedule", when: () => hasRow, run: () => { if (current) setScheduleJob({ name: current.name, cron: (summary?.schedule && summary.schedule !== "-") ? summary.schedule : "" }); } },
      { key: "m", label: "email", when: () => hasRow, run: () => {
        if (!current) return;
        const s = summary ?? {};
        const hasEmail = s.email && s.email !== "-";
        setEmailJob({
          name: current.name,
          spec: {
            enabled: !!hasEmail,
            email: hasEmail ? s.email! : "",
            emailCond: (s.email_cond && s.email_cond !== "-") ? s.email_cond : "failed",
            emailKeywords: (s.email_keywords && s.email_keywords !== "-") ? s.email_keywords : "",
            emailRegex: (s.email_regex && s.email_regex !== "-") ? s.email_regex : "",
          },
        });
      } },
      { key: "i", label: "import", when: () => canImport, run: () => { if (current) doImport(current.name); } },
      { key: "u", label: "unimport", when: () => canUntrack, run: () => { if (current) { untrackResource("job", current.name, ctx.profile, baseUrl!, ctx.dbPath); ctx.notify(`${SYM.ok} Removed '${current.name}' from Mine`, "success"); void refetch(); } } },
      { key: "d", label: "del", when: () => hasRow, run: () => { if (current) void removeJob(current.name); } },
      { key: "a", label: "mine/all", run: () => setShowAll((v) => { const nv = !v; setScopeShowAll("job", nv, ctx.dbPath); return nv; }) },
      { key: "F", label: "auto", run: () => setAutoRefresh((v) => !v) },
      search.openBinding,
      // Esc clears an active query (only shown/handled when one is set).
      { key: "Esc", label: "clear", hidden: true, when: () => search.active, run: () => search.clear() },
      { key: "R", label: "refresh", run: () => void refetch() },
    ],
    [current, hasRow, canImport, canUntrack, baseUrl, summary, runJob, stopJob, newJob, editJob, doImport, removeJob, refetch, search],
  );

  // While typing in the search box, the search hook owns input — suspend the
  // action keymap (and the table's nav) so letters don't trigger actions.
  useKeymap(bindings, { isActive: active && !logJob && !paramJob && !scheduleJob && !emailJob && !search.editing });

  // Publish hints to the shell footer while this tab is the active one.
  useEffect(() => {
    if (active && !logJob && !paramJob && !scheduleJob && !emailJob) ctx.setActiveKeyHints(bindingsToHints(bindings));
  }, [active, logJob, paramJob, scheduleJob, emailJob, bindings, ctx]);

  if (logJob) {
    return <LogViewer ctx={ctx} jobName={logJob} onClose={() => setLogJob(null)} />;
  }

  if (paramJob) {
    return (
      <ParamListEditor
        initial={[]}
        setInputCaptured={ctx.setInputCaptured}
        onResult={(params) => {
          const name = paramJob;
          setParamJob(null);
          if (!params) return;
          void (async () => {
            try {
              const client = await ctx.getClient({ useController: true });
              await updateJobFreestyle(
                client, name, null, null, null, null, null, null, null, null, false, false,
                params, params.length === 0,
              );
              ctx.notify(`${SYM.ok} Updated parameters: ${name}`, "success");
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
              await updateJobFreestyle(client, name, null, null, null, cron);
              ctx.notify(`${SYM.ok} Updated schedule: ${name}`, "success");
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
                  client, name, null, null, null, null,
                  "", null, null, null, true, true,
                );
              } else {
                const keywords = spec.emailKeywords
                  ? spec.emailKeywords.split(",").map((k) => k.trim()).filter(Boolean)
                  : null;
                await updateJobFreestyle(
                  client, name, null, null, null, null,
                  spec.email || null,
                  spec.emailCond || null,
                  keywords,
                  spec.emailRegex || null,
                  !spec.emailKeywords, // clear keywords if field left empty
                  !spec.emailRegex,    // clear regex if field left empty
                );
              }
              ctx.notify(`${SYM.ok} Updated email: ${name}`, "success");
              ctx.logCommand(`bee job update ${name} --email "${spec.email}"`);
              void refetch();
            } catch (err) {
              ctx.notify(err instanceof Error ? err.message : String(err), "error");
            }
          })();
        }}
      />
    );
  }

  const scope = showAll ? (
    <Text color={THEME.yellow}>ALL</Text>
  ) : (
    <Text color={THEME.success}>MINE</Text>
  );

  // Not-logged-in is a distinct, friendly state rather than an error.
  const notLoggedIn = !ctx.loggedIn;
  const noController = ctx.loggedIn && !ctx.activeController;
  const errMsg = error ? error.message : "";

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Header */}
      <Text>
        {" "}
        {SYM.gear} Jobs
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
            rows={jobs.map((j) => {
              const st = statusCell(j.color);
              const tp = typeLabel(j.jobType);
              const mine = trackedNames.has(j.name);
              return [
                { text: mine ? SYM.tracked : "", color: THEME.success },
                { text: st.text, color: st.color, dim: st.dim },
                { text: tp.text, color: tp.color, dim: (tp as { dim?: boolean }).dim },
                { text: j.name },
                { text: j.lastBuildNumber ? `#${j.lastBuildNumber}` : "—" },
                { text: j.description ?? "" },
              ];
            })}
            rowKeys={rowKeys}
            cursor={cursor}
            onCursorChange={setCursor}
            active={active && !search.editing}
            emptyText="No jobs. Press n to create one."
          />

          {/* Detail panel */}
          {current && (
            <Box flexDirection="column" borderStyle={borderStyle()} paddingX={1} marginTop={1}>
              <Text>
                <Text bold>{current.name}</Text>
                {"   "}
                <Text color={THEME.dim}>type:</Text> {current.jobType || "-"}
                {"   "}
                <Text color={THEME.dim}>build:</Text>{" "}
                {current.lastBuildNumber ? `#${current.lastBuildNumber}` : "—"}
              </Text>
              {summary && (
                <Text color={THEME.dim} wrap="truncate-end">
                  schedule: {summary.schedule || "-"} · email: {summary.email || "-"} · cond:{" "}
                  {summary.email_cond || "-"}
                </Text>
              )}
              <Text color={THEME.dim} wrap="truncate-end">
                {current.url || "-"}
              </Text>
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
