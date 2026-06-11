/**
 * Job CLI commands — bee job list/get/create/delete/copy/run/stop/log/status/update.
 * Ports legacy/cb/cli/commands/jobs.py
 */

import * as readline from "readline";
import type { PluginContext } from "../../registry/types";
import { printSuccess, printError, printInfo, printWarning, tableFormatter } from "../../core/cli/output";
import { getTrackedResources, trackResource, untrackResource } from "../../core/db/repositories/resource-repo";
import {
  listJobs,
  getJob,
  triggerJob,
  triggerJobWithParams,
  stopBuild,
  getBuildDetail,
  getLastBuildNumber,
  getBuildLog,
  getBuildHistory,
  waitForBuild,
  createFreestyleJob,
  createFolder,
  copyJob,
  deleteJob,
  getJobConfigSummary,
  updateJobFreestyle,
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

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
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
  const profile = "default";

  const grp = ctx.program
    .command("job")
    .description("Manage CloudBees jobs (Freestyle, Folder)");

  // ── list ──────────────────────────────────────────────────────────────────
  grp
    .command("list")
    .description("List all jobs with type and last build status")
    .option("--all", "Show all jobs (by default, only shows yours)", false)
    .action(async (opts: { all: boolean }) => {
      try {
        const client = await ctx.getClient({ useController: true });
        const allJobs = await listJobs(client);

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
        console.log(formatter.table(headers, rows));
        console.log(`  ${jobs.length} job(s)  [FS=Freestyle  PL=Pipeline  FD=Folder]`);
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
        console.log(formatter.kv(data));
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
      "When to send email (success|failed|always)",
      "failed",
    )
    .option(
      "--email-keyword <kw>",
      "Send mail only if build log contains keyword (repeatable)",
      (val: string, prev: string[]) => prev.concat([val]),
      [] as string[],
    )
    .option("--email-regex <regex>", "Send mail only if build log matches regex")
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
          paramDef: string[];
        },
      ) => {
        try {
          const shell = opts.shell ?? "echo hello";
          const client = await ctx.getClient({ useController: true });

          await createFreestyleJob(
            client,
            name,
            opts.description,
            shell,
            opts.chdir ?? null,
            opts.node ?? null,
            opts.schedule ?? null,
            opts.email ?? null,
            opts.emailCond,
            opts.emailKeyword.length > 0 ? opts.emailKeyword : null,
            opts.emailRegex ?? null,
            parseParamDefs(opts.paramDef),
          );

          trackResource("job", name, profile, client.baseUrl, dbPath);
          const nodeMsg = opts.node ? ` on node '${opts.node}'` : "";
          printSuccess(`OK Freestyle job '${name}' created.${nodeMsg}`);
          const url = `${client.baseUrl.replace(/\/$/, "")}/job/${name}/`;
          console.log(`  Link: ${url}`);
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
    .action(async (name: string, opts: { description: string }) => {
      try {
        const client = await ctx.getClient({ useController: true });
        await createFolder(client, name, opts.description);
        trackResource("job", name, profile, client.baseUrl, dbPath);
        printSuccess(`OK Folder '${name}' created.`);
        const url = `${client.baseUrl.replace(/\/$/, "")}/job/${name}/`;
        console.log(`  Link: ${url}`);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── delete ────────────────────────────────────────────────────────────────
  grp
    .command("delete")
    .description("Delete a job or folder")
    .argument("<name>", "Job name")
    .option("--yes", "Skip confirmation", false)
    .action(async (name: string, opts: { yes: boolean }) => {
      try {
        if (!opts.yes) {
          const ok = await confirm(`Delete job '${name}'? [y/N] `);
          if (!ok) {
            console.log("Cancelled.");
            return;
          }
        }

        const client = await ctx.getClient({ useController: true });

        try {
          await deleteJob(client, name);
          printSuccess(`OK Job '${name}' deleted from server.`);
        } catch (e) {
          const msg = String(e instanceof Error ? e.message : e);
          if (msg.includes("404")) {
            printInfo(`INFO Job '${name}' not found on server, removing from local tracking only.`);
          } else {
            printWarning(`WARN Could not delete job on server: ${msg}`);
            console.log("Proceeding with local removal anyway.");
          }
        }

        untrackResource("job", name, profile, client.baseUrl, dbPath);
        printSuccess(`OK Job '${name}' removed from local database.`);
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
        console.log(`  Link: ${url}`);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── import ────────────────────────────────────────────────────────────────
  grp
    .command("import")
    .description("Track an existing server job as yours (adds it to your Mine list)")
    .argument("<name>", "Job name as it appears on the server")
    .action(async (name: string) => {
      try {
        const client = await ctx.getClient({ useController: true });
        const job = await getJob(client, name);
        if (!job) {
          printError(`Job '${name}' not found on server. Nothing to import.`);
          process.exit(1);
        }
        const tracked = getTrackedResources("job", profile, client.baseUrl, dbPath);
        if (tracked.includes(name)) {
          printInfo(`INFO Job '${name}' is already imported.`);
          return;
        }
        trackResource("job", name, profile, client.baseUrl, dbPath);
        printSuccess(`OK Imported job '${name}' into your Mine list.`);
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
          const timeout = parseInt(opts.timeout, 10) || 120;

          let before = 0;
          if (opts.wait) {
            try {
              before = (await getLastBuildNumber(client, name)) ?? 0;
            } catch (e) {
              printWarning(`WARN Could not get current build number: ${e instanceof Error ? e.message : e}`);
              console.log("Will use 0 as reference.");
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
            console.error(`[ERROR] Could not trigger job: ${e instanceof Error ? e.message : e}`);
            return;
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
            console.log("  Could not determine build number. Check Jenkins manually.");
            return;
          }

          try {
            process.stdout.write(
              `Build #${newBuildNum} -- waiting for completion (timeout=${timeout}s)...\n`,
            );
            const build = await waitForBuild(client, name, newBuildNum, timeout);
            const result = build.result || "IN_PROGRESS";
            console.log(`  Result: ${result}`);
          } catch (e) {
            printError(`Error while waiting for build: ${e instanceof Error ? e.message : e}`);
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
          } else {
            try {
              buildNumber = await getLastBuildNumber(client, name);
              if (buildNumber == null) {
                console.log("No builds found.");
                return;
              }
            } catch (e) {
              console.error(`[ERROR] Could not get last build number: ${e instanceof Error ? e.message : e}`);
              return;
            }
          }

          try {
            if (!opts.follow) {
              const log = await getBuildLog(client, name, buildNumber);
              console.log(log);
              return;
            }

            // Follow mode: poll until done
            let shown = 0;
            while (true) {
              const log = await getBuildLog(client, name, buildNumber);
              const newContent = log.slice(shown);
              if (newContent) {
                process.stdout.write(newContent);
                shown = log.length;
              }
              const build = await getBuildDetail(client, name, buildNumber);
              if (!build.building) break;
              await Bun.sleep(3000);
            }
          } catch (e) {
            console.error(`[ERROR] Could not get build log: ${e instanceof Error ? e.message : e}`);
            return;
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
        const count = parseInt(opts.count, 10) || 10;
        const client = await ctx.getClient({ useController: true });
        const builds = await getBuildHistory(client, name, count);

        if (builds.length === 0) {
          console.log("No builds found.");
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
        console.log(formatter.table(headers, rows));
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
    .option("--node <node>", "Restrict job to a specific node/label")
    .option("--schedule <cron>", "Cron format schedule (e.g., 'H 8 * * *', or '' to remove)")
    .option("--email <emails>", "Comma-separated emails to notify, or '' to remove")
    .option(
      "--email-cond <cond>",
      "When to send email (success|failed|always)",
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

          await updateJobFreestyle(
            client,
            name,
            opts.description ?? null,
            opts.shell ?? null,
            opts.node ?? null,
            opts.schedule ?? null,
            opts.email ?? null,
            opts.emailCond ?? null,
            emailKeywordsInput,
            opts.emailRegex ?? null,
            opts.clearEmailKeywords,
            opts.clearEmailRegex,
            paramsInput,
            opts.clearParams,
          );

          printSuccess(`OK Freestyle job '${name}' updated.`);
        } catch (err) {
          printError(String(err instanceof Error ? err.message : err), err);
          process.exit(1);
        }
      },
    );
}
