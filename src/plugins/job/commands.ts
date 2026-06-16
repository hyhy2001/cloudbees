/**
 * Job CLI commands — bee job list/get/create/delete/copy/run/stop/log/status/update.
 * Ports legacy/cb/cli/commands/jobs.py
 */

import type { PluginContext } from "../../registry/types";
import { printSuccess, printError, printInfo, printWarning, printMessage, tableFormatter } from "../../core/cli/output";
import { confirm } from "../../core/cli/utils";
import { NotFoundError } from "../../core/api/errors";
import { getTrackedResources, trackResource, untrackResource } from "../../core/db/repositories/resource-repo";
import { getActiveProfileName } from "../../core/session/index";
import {
  listJobs,
  listJobsRecursive,
  getJob,
  triggerJob,
  triggerJobWithParams,
  stopBuild,
  getBuildDetail,
  getLastBuildNumber,
  getBuildLog,
  streamBuildLog,
  getBuildHistory,
  waitForBuild,
  createFreestyleJob,
  createFolder,
  copyJob,
  moveJob,
  deleteJob,
  getJobConfigSummary,
  updateJobFreestyle,
  approveAgentForFolder,
  listControlledAgents,
  removeAgentFromFolder,
} from "./service";
import type { StringParamDef } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapColor(color: string): string {
  const isRunning = color.includes("_anime");
  const base = color.replace("_anime", "");
  const state =
    (
      ({
        blue: "OK",
        red: "FAIL",
        yellow: "WARN",
        aborted: "ABORTED",
        notbuilt: "NEW",
        disabled: "DISABLED",
      }) as Record<string, string>
    )[base] ?? (base ? base.toUpperCase() : "UNKNOWN");
  return isRunning ? `${state} (Run)` : state;
}


/**
 * Parse repeatable `--param-def NAME=default` flags into StringParamDef[].
 * Splits on the first `=`; no `=` means an empty default. Empty input → [].
 */
function parseParamDefs(raw: string[]): StringParamDef[] {
  return raw.map((p) => {
    const idx = p.indexOf("=");
    if (idx < 0) return { name: p.trim(), defaultValue: "" };
    return { name: p.slice(0, idx).trim(), defaultValue: p.slice(idx + 1) };
  }).filter((d) => d.name.length > 0);
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export function registerJobCommands(ctx: PluginContext): void {
  const dbPath = process.env["CB_DB_PATH"];
  const profile = getActiveProfileName(dbPath);

  const grp = ctx.program
    .command("job")
    .description("Manage CloudBees jobs (Freestyle, Folder)");

  // ── list ──────────────────────────────────────────────────────────────────
  grp
    .command("list")
    .description("List all jobs with type and last build status")
    .option("--all", "Show all jobs (by default, only shows yours)", false)
    .option("--recursive", "Descend into folders and list jobs at all levels", false)
    .action(async (opts: { all: boolean; recursive: boolean }) => {
      try {
        const client = await ctx.getClient({ useController: true });
        const allJobs = opts.recursive
          ? await listJobsRecursive(client)
          : await listJobs(client);

        let jobs = allJobs;
        if (!opts.all) {
          const tracked = getTrackedResources("job", profile, client.baseUrl, dbPath);
          const trackedSet = new Set(tracked);
          const serverNames = new Set(allJobs.map((j) => j.name));

          const displayJobs = allJobs.filter((j) => trackedSet.has(j.name));

          for (const missing of trackedSet) {
            if (!serverNames.has(missing)) {
              displayJobs.push({
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

          jobs = displayJobs;
        }

        const headers = ["Name", "Type", "Status", "Build#", "Description"];
        const rows = jobs.map((j) => [
          j.name.slice(0, 30),
          j.jobType || "?",
          mapColor(j.color).slice(0, 14),
          String(j.lastBuildNumber ?? "-"),
          (j.description ?? "").slice(0, 30),
        ]);

        const formatter = ctx.getFormatter("table") ?? tableFormatter;
        printMessage(formatter.table(headers, rows));
        printMessage(`  ${jobs.length} job(s)  [FS=Freestyle  PL=Pipeline  FD=Folder]`);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── get ───────────────────────────────────────────────────────────────────
  grp
    .command("get")
    .description("Show job details and last build info")
    .argument("<name>", "Job name")
    .action(async (name: string) => {
      try {
        const client = await ctx.getClient({ useController: true });
        const job = await getJob(client, name);

        if (!job) {
          console.error(`ERROR Job '${name}' not found.`);
          process.exit(1);
        }

        const summary = await getJobConfigSummary(client, name);
        const data: Record<string, unknown> = {
          name: job.name,
          url: job.url,
          color: job.color,
          buildable: job.buildable,
          lastBuildNumber: job.lastBuildNumber,
          lastBuildUrl: job.lastBuildUrl,
          description: job.description,
          jobClass: job.jobClass,
          jobType: job.jobType,
          schedule: summary.schedule,
          email: summary.email,
          email_cond: summary.email_cond,
          email_keywords: summary.email_keywords,
          email_regex: summary.email_regex,
        };

        const formatter = ctx.getFormatter("table") ?? tableFormatter;
        printMessage(formatter.kv(data));
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── create ────────────────────────────────────────────────────────────────
  const createGrp = grp.command("create").description("Create a new job");

  createGrp
    .command("freestyle")
    .description("Create a Freestyle project")
    .argument("<name>", "Job name")
    .option("--description <desc>", "Job description", "")
    .option("--shell <cmd>", "Shell command to run")
    .option("--chdir <dir>", "Working directory for the script")
    .option("--node <node>", "Restrict job to a specific node/label")
    .option("--schedule <cron>", "Cron format schedule (e.g., 'H 8 * * *')")
    .option("--email <emails>", "Comma-separated emails to notify")
    .option(
      "--email-cond <cond>",
      "When to send email: failed | success | always | custom (custom = keyword/regex filter)",
      "failed",
    )
    .option(
      "--email-keyword <kw>",
      "Send mail only if build log contains keyword (repeatable)",
      (val: string, prev: string[]) => prev.concat([val]),
      [] as string[],
    )
    .option("--email-regex <regex>", "Send mail only if build log matches regex")
    .option("--folder <path>", "Parent folder to create the job in (e.g. 'team/backend')")
    .option(
      "--param-def <name=default>",
      "Define a String build parameter, NAME=default (repeatable)",
      (val: string, prev: string[]) => prev.concat([val]),
      [] as string[],
    )
    .action(
      async (
        name: string,
        opts: {
          description: string;
          shell?: string;
          chdir?: string;
          node?: string;
          schedule?: string;
          email?: string;
          emailCond: string;
          emailKeyword: string[];
          emailRegex?: string;
          folder?: string;
          paramDef: string[];
        },
      ) => {
        try {
          const client = await ctx.getClient({ useController: true });
          const folder = opts.folder || null;

          await createFreestyleJob(client, name, {
            desc: opts.description,
            shellCmd: opts.shell ?? "echo hello",
            chdir: opts.chdir ?? null,
            node: opts.node ?? null,
            schedule: opts.schedule ?? null,
            email: opts.email ?? null,
            emailCond: opts.emailCond,
            emailKeywords: opts.emailKeyword.length > 0 ? opts.emailKeyword : null,
            emailRegex: opts.emailRegex ?? null,
            params: parseParamDefs(opts.paramDef),
          }, folder);

          const qualified = folder ? `${folder}/${name}` : name;
          trackResource("job", qualified, profile, client.baseUrl, dbPath);
          const nodeMsg = opts.node ? ` on node '${opts.node}'` : "";
          printSuccess(`OK Freestyle job '${qualified}' created.${nodeMsg}`);
          if (!opts.node) {
            printWarning(`WARN No node assigned — job will run on any available agent.`);
          }
          const url = `${client.baseUrl.replace(/\/$/, "")}/job/${qualified.split("/").join("/job/")}/`;
          printMessage(`  Link: ${url}`);
        } catch (err) {
          printError(String(err instanceof Error ? err.message : err), err);
          process.exit(1);
        }
      },
    );

  createGrp
    .command("folder")
    .description("Create a Folder")
    .argument("<name>", "Folder name")
    .option("--description <desc>", "Folder description", "")
    .option("--folder <path>", "Parent folder to create the folder in (e.g. 'team')")
    .action(async (name: string, opts: { description: string; folder?: string }) => {
      try {
        const client = await ctx.getClient({ useController: true });
        const folder = opts.folder || null;
        await createFolder(client, name, opts.description, folder);
        const qualified = folder ? `${folder}/${name}` : name;
        trackResource("job", qualified, profile, client.baseUrl, dbPath);
        printSuccess(`OK Folder '${qualified}' created.`);
        const url = `${client.baseUrl.replace(/\/$/, "")}/job/${qualified.split("/").join("/job/")}/`;
        printMessage(`  Link: ${url}`);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── delete ────────────────────────────────────────────────────────────────
  grp
    .command("delete")
    .description("Delete one or more jobs or folders")
    .argument("<names...>", "Job name(s)")
    .option("--yes", "Skip confirmation", false)
    .action(async (names: string[], opts: { yes: boolean }) => {
      try {
        if (!opts.yes) {
          const label = names.length === 1 ? `job '${names[0]}'` : `${names.length} jobs`;
          const ok = await confirm(`Delete ${label}? [y/N] `);
          if (!ok) {
            printInfo("INFO Cancelled.");
            return;
          }
        }

        const client = await ctx.getClient({ useController: true });

        for (const name of names) {
          try {
            await deleteJob(client, name);
            printSuccess(`OK Job '${name}' deleted from server.`);
          } catch (e) {
            if (e instanceof NotFoundError) {
              printInfo(`INFO Job '${name}' not found on server, removing from local tracking only.`);
            } else {
              const msg = e instanceof Error ? e.message : String(e);
              printWarning(`WARN Could not delete job '${name}' on server: ${msg}`);
              printInfo("INFO Proceeding with local removal anyway.");
            }
          }
          untrackResource("job", name, profile, client.baseUrl, dbPath);
          printSuccess(`OK Job '${name}' removed from local database.`);
        }
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── copy ──────────────────────────────────────────────────────────────────
  grp
    .command("copy")
    .description("Clone an existing job")
    .argument("<source>", "Source job name")
    .argument("<destination>", "Destination job name")
    .action(async (source: string, destination: string) => {
      try {
        const client = await ctx.getClient({ useController: true });
        await copyJob(client, source, destination);
        trackResource("job", destination, profile, client.baseUrl, dbPath);
        printSuccess(`OK Job '${source}' cloned to '${destination}'.`);
        const url = `${client.baseUrl.replace(/\/$/, "")}/job/${destination}/`;
        printMessage(`  Link: ${url}`);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── move ──────────────────────────────────────────────────────────────────
  grp
    .command("move")
    .description("Move a job to a different folder (copy config.xml to dest, delete source)")
    .argument("<source>", "Source job qualified name (e.g. folderA/my-job)")
    .argument("<folder>", "Destination folder name, or '.' for root")
    .action(async (source: string, folder: string) => {
      try {
        const destFolder = folder === "." ? null : folder;
        const client = await ctx.getClient({ useController: true });
        const qualified = await moveJob(client, source, destFolder);
        untrackResource("job", source, profile, client.baseUrl, dbPath);
        trackResource("job", qualified, profile, client.baseUrl, dbPath);
        const destLabel = destFolder ?? "/";
        printSuccess(`OK Job '${source}' moved to '${destLabel}' as '${qualified}'.`);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── track ────────────────────────────────────────────────────────────────
  grp
    .command("track")
    .description("Track one or more existing server jobs (adds them to your Mine list)")
    .argument("<names...>", "Job name(s) as they appear on the server")
    .action(async (names: string[]) => {
      try {
        const client = await ctx.getClient({ useController: true });
        const tracked = getTrackedResources("job", profile, client.baseUrl, dbPath);
        const trackedSet = new Set(tracked);
        for (const name of names) {
          const job = await getJob(client, name);
          if (!job) {
            printError(`Job '${name}' not found on server. Skipping.`);
            continue;
          }
          if (trackedSet.has(name)) {
            printInfo(`INFO Job '${name}' is already tracked.`);
            continue;
          }
          trackResource("job", name, profile, client.baseUrl, dbPath);
          trackedSet.add(name);
          printSuccess(`OK Tracked job '${name}'.`);
        }
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── untrack ─────────────────────────────────────────────────────────────────
  grp
    .command("untrack")
    .description("Remove one or more jobs from Mine (does not delete from server)")
    .argument("<names...>", "Job name(s) as they appear on the server")
    .action(async (names: string[]) => {
      try {
        const client = await ctx.getClient({ useController: true });
        const tracked = getTrackedResources("job", profile, client.baseUrl, dbPath);
        const trackedSet = new Set(tracked);
        for (const name of names) {
          if (!trackedSet.has(name)) {
            printInfo(`INFO Job '${name}' is not in Mine.`);
            continue;
          }
          untrackResource("job", name, profile, client.baseUrl, dbPath);
          trackedSet.delete(name);
          printSuccess(`OK Removed job '${name}' from Mine.`);
        }
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── run ───────────────────────────────────────────────────────────────────
  grp
    .command("run")
    .description("Trigger a job build")
    .argument("<name>", "Job name")
    .option(
      "-p, --param <param>",
      "Parameter in KEY=value format (repeatable)",
      (val: string, prev: string[]) => prev.concat([val]),
      [] as string[],
    )
    .option("--wait", "Wait for build to finish", false)
    .option("--timeout <seconds>", "Max wait time in seconds", "120")
    .action(
      async (
        name: string,
        opts: { param: string[]; wait: boolean; timeout: string },
      ) => {
        try {
          const client = await ctx.getClient({ useController: true });
          const parsedTimeout = parseInt(opts.timeout, 10);
          const timeout = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 120;
          if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
            printWarning(`WARN Invalid --timeout '${opts.timeout}'; defaulted to 120s.`);
          }

          let before = 0;
          if (opts.wait) {
            try {
              before = (await getLastBuildNumber(client, name)) ?? 0;
            } catch (e) {
              printWarning(`WARN Could not get current build number: ${e instanceof Error ? e.message : e}`);
              printInfo("INFO Will use 0 as reference.");
              before = 0;
            }
          }

          try {
            if (opts.param.length > 0) {
              const paramDict: Record<string, string> = {};
              for (const p of opts.param) {
                const idx = p.indexOf("=");
                if (idx >= 0) {
                  paramDict[p.slice(0, idx)] = p.slice(idx + 1);
                } else {
                  paramDict[p] = "";
                }
              }
              await triggerJobWithParams(client, name, paramDict);
            } else {
              await triggerJob(client, name);
            }
            printSuccess(`OK Triggered: ${name}`);
          } catch (e) {
            printError(`Could not trigger job: ${e instanceof Error ? e.message : e}`);
            process.exit(1);
          }

          if (!opts.wait) return;

          // Wait for a new build to appear (up to 15s)
          let newBuildNum: number | null = null;
          process.stdout.write("Waiting for build to start...\n");
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            try {
              const current = await getLastBuildNumber(client, name);
              if (current != null && current > before) {
                newBuildNum = current;
                break;
              }
            } catch {
              // ignore
            }
            await Bun.sleep(2000);
          }

          if (newBuildNum == null) {
            printWarning("WARN Could not determine build number. Check Jenkins manually.");
            process.exit(1);
          }

          try {
            process.stdout.write(
              `Build #${newBuildNum} -- waiting for completion (timeout=${timeout}s)...\n`,
            );
            const build = await waitForBuild(client, name, newBuildNum, timeout);
            const result = build.result || "IN_PROGRESS";
            printMessage(`  Result: ${result}`);
          } catch (e) {
            printError(`Error while waiting for build: ${e instanceof Error ? e.message : e}`);
            process.exit(1);
          }
        } catch (err) {
          printError(String(err instanceof Error ? err.message : err), err);
          process.exit(1);
        }
      },
    );

  // ── stop ──────────────────────────────────────────────────────────────────
  grp
    .command("stop")
    .description("Stop a running build")
    .argument("<name>", "Job name")
    .argument("<build_number>", "Build number")
    .action(async (name: string, buildNumberStr: string) => {
      try {
        const buildNumber = parseInt(buildNumberStr, 10);
        if (!Number.isInteger(buildNumber) || String(buildNumber) !== buildNumberStr.trim()) {
          printError(`Invalid build number: '${buildNumberStr}' — must be a positive integer`);
          process.exit(1);
        }
        const client = await ctx.getClient({ useController: true });
        await stopBuild(client, name, buildNumber);
        printSuccess(`OK Stop requested: ${name} #${buildNumber}`);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── log ───────────────────────────────────────────────────────────────────
  grp
    .command("log")
    .description("Print console log for a build (default: last build)")
    .argument("<name>", "Job name")
    .argument("[build_number]", "Build number (default: last)")
    .option("-f, --follow", "Stream log (poll every 3s until build completes)", false)
    .action(
      async (name: string, buildNumberArg: string | undefined, opts: { follow: boolean }) => {
        try {
          const client = await ctx.getClient({ useController: true });

          let buildNumber: number | null = null;
          if (buildNumberArg != null) {
            buildNumber = parseInt(buildNumberArg, 10);
            if (Number.isNaN(buildNumber)) {
              printError(`Invalid build number: '${buildNumberArg}'`);
              process.exit(1);
            }
          } else {
            try {
              buildNumber = await getLastBuildNumber(client, name);
              if (buildNumber == null) {
                printInfo("INFO No builds found.");
                return;
              }
            } catch (e) {
              printError(`Could not get last build number: ${e instanceof Error ? e.message : e}`);
              process.exit(1);
            }
          }

          try {
            if (!opts.follow) {
              const log = await getBuildLog(client, name, buildNumber);
              printMessage(log);
              return;
            }

            // Follow mode: use progressive text (byte-offset) to avoid re-downloading
            // the whole log on every poll.
            let offset = 0;
            let lastBuild = await getBuildDetail(client, name, buildNumber);
            while (true) {
              const [text, newOffset, hasMore] = await streamBuildLog(client, name, buildNumber, offset);
              if (text) {
                process.stdout.write(text);
                offset = newOffset;
              }
              if (!hasMore) {
                // Confirm the build is really done (hasMore=false can be transient)
                lastBuild = await getBuildDetail(client, name, buildNumber);
                if (!lastBuild.building) break;
              }
              await Bun.sleep(3000);
            }
            const result = lastBuild.result ?? "UNKNOWN";
            printMessage(`\n  Build #${buildNumber} result: ${result}`);
          } catch (e) {
            printError(`Could not get build log: ${e instanceof Error ? e.message : e}`);
            process.exit(1);
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") return; // keyboard interrupt
          printError(String(err instanceof Error ? err.message : err), err);
          process.exit(1);
        }
      },
    );

  // ── status ────────────────────────────────────────────────────────────────
  grp
    .command("status")
    .description("Show recent build history for a job")
    .argument("<name>", "Job name")
    .option("--count <n>", "Number of recent builds to show", "10")
    .action(async (name: string, opts: { count: string }) => {
      try {
        const parsedCount = parseInt(opts.count, 10);
        const count = Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : 10;
        const client = await ctx.getClient({ useController: true });
        const builds = await getBuildHistory(client, name, count);

        if (builds.length === 0) {
          printInfo("INFO No builds found.");
          return;
        }

        const headers = ["Build#", "Result", "Duration", "Timestamp"];
        const rows = builds.map((b) => {
          const ts = b.timestamp
            ? new Date(b.timestamp).toISOString().replace("T", " ").slice(0, 16)
            : "-";
          const dur = b.duration ? `${Math.floor(b.duration / 1000)}s` : "-";
          const result = b.result ? b.result : b.building ? "RUNNING" : "-";
          return [String(b.number), result, dur, ts];
        });

        const formatter = ctx.getFormatter("table") ?? tableFormatter;
        printMessage(formatter.table(headers, rows));
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── update ────────────────────────────────────────────────────────────────
  const updateGrp = grp.command("update").description("Update an existing job's configuration");

  updateGrp
    .command("freestyle")
    .description("Update a Freestyle project's configuration")
    .argument("<name>", "Job name")
    .option("--description <desc>", "Job description")
    .option("--shell <cmd>", "Shell command to run")
    .option("--chdir <dir>", "Working dir prepended to --shell as 'cd <dir> && <cmd>'")
    .option("--node <node>", "Restrict job to a specific node/label")
    .option("--schedule <cron>", "Cron format schedule (e.g., 'H 8 * * *', or '' to remove)")
    .option("--email <emails>", "Comma-separated emails to notify, or '' to remove")
    .option(
      "--email-cond <cond>",
      "When to send email: failed | success | always | custom (custom = keyword/regex filter)",
    )
    .option(
      "--email-keyword <kw>",
      "Replace keyword filters (repeatable)",
      (val: string, prev: string[]) => prev.concat([val]),
      [] as string[],
    )
    .option("--email-regex <regex>", "Replace regex filter (case-insensitive)")
    .option("--clear-email-keywords", "Clear all configured email keywords", false)
    .option("--clear-email-regex", "Clear configured email regex", false)
    .option(
      "--param-def <name=default>",
      "Replace String parameters (repeatable, NAME or NAME=default)",
      (val: string, prev: string[]) => prev.concat([val]),
      [] as string[],
    )
    .option("--clear-params", "Remove all String parameters", false)
    .action(
      async (
        name: string,
        opts: {
          description?: string;
          shell?: string;
          chdir?: string;
          node?: string;
          schedule?: string;
          email?: string;
          emailCond?: string;
          emailKeyword: string[];
          emailRegex?: string;
          clearEmailKeywords: boolean;
          clearEmailRegex: boolean;
          paramDef: string[];
          clearParams: boolean;
        },
      ) => {
        try {
          const client = await ctx.getClient({ useController: true });

          // Only pass emailKeywords if the option was explicitly provided (non-empty array)
          const emailKeywordsInput =
            opts.emailKeyword.length > 0 ? opts.emailKeyword : null;

          const paramsInput =
            opts.paramDef.length > 0 ? parseParamDefs(opts.paramDef) : null;

          // --chdir folds into the shell command (the service has no chdir slot):
          // "cd <dir> && <cmd>". Only meaningful alongside --shell; without --shell
          // there's nothing to prepend to, so chdir alone is a no-op.
          if (opts.chdir && !opts.shell) {
            printWarning("WARN --chdir has no effect without --shell; ignored.");
          }
          const shellInput =
            opts.shell != null && opts.chdir
              ? `cd ${opts.chdir} && ${opts.shell}`
              : opts.shell ?? null;

          await updateJobFreestyle(
            client,
            name,
            {
              desc: opts.description ?? null,
              shellCmd: shellInput,
              node: opts.node ?? null,
              schedule: opts.schedule ?? null,
              email: opts.email ?? null,
              emailCond: opts.emailCond ?? null,
              emailKeywords: emailKeywordsInput,
              emailRegex: opts.emailRegex ?? null,
              clearEmailKeywords: opts.clearEmailKeywords,
              clearEmailRegex: opts.clearEmailRegex,
              params: paramsInput,
              clearParams: opts.clearParams,
            },
          );

          printSuccess(`OK Freestyle job '${name}' updated.`);
          if (opts.node === "") {
            printWarning(`WARN Node cleared — job will run on any available agent.`);
          }
        } catch (err) {
          printError(String(err instanceof Error ? err.message : err), err);
          process.exit(1);
        }
      },
    );

  // ── Folders Plus controlled agents (FD folders only) ─────────────────────

  grp
    .command("list-agents")
    .description("List agents approved to run builds from a folder")
    .argument("<folder>", "Folder path (e.g. 'team' or 'team/backend')")
    .action(async (folder: string) => {
      try {
        const client = await ctx.getClient({ useController: true });
        const grants = await listControlledAgents(client, folder);
        if (grants.length === 0) {
          printInfo("INFO No controlled-agent grants found (or Folders Plus not installed).");
          return;
        }
        const headers = ["Agent", "Grant ID"];
        const rows = grants.map((g) => [g.agentName ?? "(unassigned)", g.grantId]);
        printMessage(tableFormatter.table(headers, rows));
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  grp
    .command("approve-agent")
    .description("Approve an agent to run builds from a folder (Folders Plus handshake)")
    .argument("<folder>", "Folder path (e.g. 'team' or 'team/backend')")
    .argument("<agent>", "Agent name")
    .action(async (folder: string, agent: string) => {
      try {
        const client = await ctx.getClient({ useController: true });
        printMessage(`  Running handshake: folder='${folder}' agent='${agent}'…`);
        await approveAgentForFolder(client, folder, agent);
        printSuccess(`OK Agent '${agent}' approved for folder '${folder}'.`);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  grp
    .command("remove-agent")
    .description("Remove an agent's approval from a folder")
    .argument("<folder>", "Folder path")
    .argument("<agent>", "Agent name (as shown by 'list-agents')")
    .option("--yes", "Skip confirmation", false)
    .action(async (folder: string, agent: string, opts: { yes: boolean }) => {
      try {
        if (!opts.yes) {
          const ok = await confirm(`Remove agent '${agent}' from '${folder}'? [y/N] `);
          if (!ok) { printInfo("INFO Cancelled."); return; }
        }
        const client = await ctx.getClient({ useController: true });
        await removeAgentFromFolder(client, folder, agent);
        printSuccess(`OK Agent '${agent}' removed from '${folder}'.`);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });
}
