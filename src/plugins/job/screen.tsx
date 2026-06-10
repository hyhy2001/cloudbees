/**
 * Jobs TUI tab — port of legacy/cb/tui/screens/jobs_screen.py.
 *
 * Full feature parity with the CLI: list, run, stop, view log, create, delete,
 * Mine/All toggle with tracked-resource filtering, and a per-cursor detail panel.
 *
 * The component talks to the SAME service layer as the CLI (src/plugins/job/service.ts)
 * — no logic is duplicated here, only presentation + interaction.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { FC } from "react";
import type { TuiScreen, TuiScreenProps, TuiContext } from "../../registry/types";
import type { CloudBeesClient } from "../../core/api/types";
import { SYM, borderStyle } from "../../core/tui/symbols";
import { THEME } from "../../core/tui/theme";
import { Spinner } from "../../core/tui/components/Spinner";
import { DataTable } from "../../core/tui/components/DataTable";
import { ConfirmModal } from "../../core/tui/components/ConfirmModal";
import { FormModal } from "../../core/tui/components/FormModal";
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
} from "./service";
import { getTrackedResources, trackResource, untrackResource } from "../../core/db/repositories/resource-repo";

const PROFILE = "default";

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
const MAX_LINES = 2000;

function colorForLine(line: string): string | undefined {
  const u = line.toUpperCase();
  if (u.includes("ERROR") || u.includes("FAILED") || u.includes("FAILURE") || u.includes("EXCEPTION"))
    return THEME.error;
  if (u.includes("WARN")) return THEME.warning;
  if (u.includes("SUCCESS") || u.includes("FINISHED") || u.includes("COMPLETED")) return THEME.success;
  if (line.includes("[Pipeline]") || line.startsWith("+")) return THEME.blue;
  return undefined;
}

const LogViewer: FC<LogViewerProps> = ({ ctx, jobName, onClose }) => {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState("connecting…");
  const offsetRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  useInput((input, key) => {
    if (key.escape || input === "q" || input === "b") onClose();
  });

  useEffect(() => {
    cancelledRef.current = false;

    const poll = async () => {
      if (cancelledRef.current) return;
      try {
        const client = await ctx.getClient({ useController: true });
        const [text, newOffset, hasMore] = await streamLastBuildLog(client, jobName, offsetRef.current);
        if (cancelledRef.current) return;
        if (text) {
          const newLines = text.split("\n");
          setLines((prev) => {
            const merged = [...prev, ...newLines];
            return merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged;
          });
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
  }, [ctx, jobName]);

  // Show only the tail that fits a typical viewport.
  const visible = lines.slice(-30);

  return (
    <Box flexDirection="column" borderStyle={borderStyle()} paddingX={1} flexGrow={1}>
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
  const [jobs, setJobs] = useState<JobDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(true);
  const [cursor, setCursor] = useState(0);

  // Detail panel (config summary for the highlighted job).
  const [summary, setSummary] = useState<Record<string, string> | null>(null);

  // Overlays local to this tab.
  const [logJob, setLogJob] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (!ctx.loggedIn) {
        setError("Not logged in — press l");
        setJobs([]);
        setLoading(false);
        return;
      }
      const client = await ctx.getClient({ useController: true });
      const all = await listJobs(client);

      let display = all;
      if (!showAll) {
        const tracked = new Set(
          getTrackedResources("job", PROFILE, client.baseUrl, ctx.dbPath),
        );
        const serverNames = new Set(all.map((j) => j.name));
        display = all.filter((j) => tracked.has(j.name));
        for (const missing of tracked) {
          if (!serverNames.has(missing)) {
            display.push({
              id: missing,
              name: missing,
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
      }
      setJobs(display);
      setCursor((c) => Math.min(c, Math.max(0, display.length - 1)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ctx, showAll]);

  // Initial + reload on Mine/All toggle.
  useEffect(() => {
    void load();
  }, [load]);

  // Fetch config summary for the highlighted job (detail panel).
  const current = jobs[cursor];
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
        void load();
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [ctx, load],
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
        void load();
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [ctx, load],
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
        untrackResource("job", name, PROFILE, client.baseUrl, ctx.dbPath);
        ctx.notify(`${SYM.ok} Deleted: ${name}`, "success");
        void load();
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [ctx, load],
  );

  const newJob = useCallback(async () => {
    const result = await ctx.openModal<Record<string, string>>({
      id: "create-job",
      render: (resolve) => (
        <FormModal
          title={`${SYM.gear} Create New Job`}
          fields={[
            { name: "name", label: "Job Name", required: true },
            { name: "job_type", label: "Type (freestyle/folder)", initial: "freestyle" },
            { name: "desc", label: "Description" },
            { name: "shell_cmd", label: "Shell Command (freestyle)" },
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
        );
      }
      trackResource("job", result.name, PROFILE, client.baseUrl, ctx.dbPath);
      ctx.notify(`${SYM.ok} Created ${jobType}: ${result.name}`, "success");
      void load();
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [ctx, load]);

  // Tab-local key handling — gated on `active` and no overlay open.
  useInput(
    (input, key) => {
      if (logJob) return; // log viewer owns input while open
      if (key.return) {
        // Detail is shown inline; Enter opens the log as the most useful action.
        if (current) setLogJob(current.name);
        return;
      }
      switch (input) {
        case "a":
          setShowAll((v) => !v);
          break;
        case "r":
          if (current) void runJob(current.name);
          break;
        case "s":
          if (current) void stopJob(current);
          break;
        case "l":
          if (current) setLogJob(current.name);
          break;
        case "n":
          void newJob();
          break;
        case "d":
          if (current) void removeJob(current.name);
          break;
        case "R":
          void load();
          break;
        default:
          break;
      }
    },
    { isActive: active && !logJob },
  );

  if (logJob) {
    return <LogViewer ctx={ctx} jobName={logJob} onClose={() => setLogJob(null)} />;
  }

  const scope = showAll ? (
    <Text color={THEME.yellow}>ALL</Text>
  ) : (
    <Text color={THEME.success}>MINE</Text>
  );

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Header */}
      <Text>
        {" "}
        {SYM.gear} Jobs{"  "}
        <Text color={THEME.dim}>r=run · s=stop · l=log · n=new · d=del · a=mine/all · R=refresh</Text>
      </Text>
      <Text>
        {" "}
        {SYM.arrow} Scope: {scope}
      </Text>

      {/* Body */}
      {loading ? (
        <Box marginTop={1}>
          <Spinner label="Loading jobs…" />
        </Box>
      ) : error ? (
        <Box marginTop={1}>
          <Text color={THEME.error}>
            {SYM.fail} {error}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <DataTable
            columns={[
              { header: "Status", width: 12 },
              { header: "T", width: 3 },
              { header: "Name", width: 42 },
              { header: "Build #", width: 9 },
              { header: "Description", width: 30 },
            ]}
            rows={jobs.map((j) => {
              const st = statusCell(j.color);
              const tp = typeLabel(j.jobType);
              return [
                { text: st.text, color: st.color, dim: st.dim },
                { text: tp.text, color: tp.color, dim: (tp as { dim?: boolean }).dim },
                { text: j.name.slice(0, 42) },
                { text: j.lastBuildNumber ? `#${j.lastBuildNumber}` : "—" },
                { text: (j.description ?? "").slice(0, 30) },
              ];
            })}
            cursor={cursor}
            onCursorChange={setCursor}
            active={active}
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
