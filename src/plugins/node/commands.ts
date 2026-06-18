/**
 * Node plugin CLI commands — `bee node ...`.
 * Ports legacy/cb/cli/commands/nodes.py with 1:1 behavior and strings.
 */
import type { PluginContext } from "../../registry/types";
import { printError, printInfo, printSuccess, printWarning, printMessage, tableFormatter } from "../../core/cli/output";import { confirm } from "../../core/cli/utils";
import { NotFoundError } from "../../core/api/errors";
import { getActiveProfileName } from "../../core/session/index";
import {
  getTrackedResources,
  trackResource,
  untrackResource,
} from "../../core/db/repositories/resource-repo";
import {
  listNodes,
  getNode,
  createPermanentNode,
  copyNode,
  deleteNode,
  toggleOffline,
  updateNode,
  DEFAULT_JAVA_PATH,
} from "./service";


export function registerNodeCommands(ctx: PluginContext): void {
  const dbPath = process.env["CB_DB_PATH"];
  const profile = getActiveProfileName(dbPath);

  const grp = ctx.program.command("node").description("Manage CloudBees build agents, workers, and executor nodes");

  // ── list ────────────────────────────────────────────────────────────────────
  grp
    .command("list")
    .description("List build agents (workers / nodes) with online/offline status; use --all to show every node on the server")
    .option("--all", "Show all nodes (by default, only shows yours)", false)
    .action(async (opts: { all: boolean }) => {
      try {
        const client = await ctx.getClient({ useController: true });
        const allNodes = await listNodes(client);

        let nodes = allNodes;
        if (!opts.all) {
          const tracked = getTrackedResources("node", profile, client.baseUrl, dbPath);
          const trackedSet = new Set(tracked);
          const serverNames = new Set(allNodes.map((n) => n.name));
          nodes = allNodes.filter((n) => trackedSet.has(n.name));
          for (const missing of trackedSet) {
            if (!serverNames.has(missing)) {
              nodes.push({
                name: missing,
                displayName: missing,
                offline: true,
                numExecutors: 0,
                labels: "[DELETED_ON_SERVER]",
                description: "",
              });
            }
          }
        }

        const headers = ["Name", "Status", "Executors", "Labels", "Description"];
        const rows = nodes.map((n) => [
          n.name.slice(0, 28),
          n.offline ? "OFFLINE" : "ONLINE",
          String(n.numExecutors),
          (n.labels || "").slice(0, 20),
          (n.description || "").slice(0, 25),
        ]);
        printMessage(tableFormatter.table(headers, rows));
        printMessage(`  ${nodes.length} node(s)`);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── get ──────────────────────────────────────────────────────────────────────
  grp
    .command("get")
    .argument("<name>")
    .description("Show node (agent / worker) details: status, executors, labels, launcher type, remote dir")
    .action(async (name: string) => {
      try {
        const client = await ctx.getClient({ useController: true });
        const node = await getNode(client, name);
        printMessage(
          tableFormatter.kv({
            name: node.name,
            offline: node.offline,
            executors: node.numExecutors,
            labels: node.labels,
            launcher: node.launcherType,
            remote_dir: node.remoteDir,
            description: node.description,
          }),
        );
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── create ─────────────────────────────────────────────────────────────────
  grp
    .command("create")
    .description("Add / create a new Permanent Agent (build agent / worker) — SSH launcher (--host + --cred-id) or JNLP/Inbound (no --host); set labels, executors, remote dir, and availability at creation time")
    .argument("<name>", "Node name")
    .requiredOption("--remote-dir <dir>", "Remote working directory on agent (e.g. /home/jenkins)")
    .option("--executors <n>", "Number of executors (parallel build slots)", "1")
    .option("--labels <labels>", "Space-separated node labels (used to restrict jobs to this agent)", "")
    .option("--description <desc>", "Human-readable description for this node", "")
    .option("--host <host>", "SSH host IP/hostname — omit to create a JNLP/Inbound agent instead", "")
    .option("--port <port>", "SSH port (default 22)", "22")
    .option("--cred-id <id>", "Credential ID for SSH connection when creating this node (SSH launcher only)", "")
    .option("--java-path <path>", "Path to Java executable on agent (SSH launcher)", DEFAULT_JAVA_PATH)
    .option("--availability <mode>", "Retention/availability strategy: always (default) | demand", "always")
    .option("--in-demand-delay <min>", "Minutes of demand before bringing online (demand availability only)", "0")
    .option("--idle-delay <min>", "Minutes idle before going offline (demand availability only)", "1")
    .action(
      async (
        name: string,
        opts: {
          remoteDir: string;
          executors: string;
          labels: string;
          description: string;
          host: string;
          port: string;
          credId: string;
          javaPath: string;
          availability: string;
          inDemandDelay: string;
          idleDelay: string;
        },
      ) => {
        try {
          const client = await ctx.getClient({ useController: true });

          // Skip if the node already exists (mirrors Python's pre-check).
          try {
            await getNode(client, name);
            printInfo(`INFO Node '${name}' already exists.`);
            return;
          } catch (e) {
            if (!(e instanceof NotFoundError)) throw e;
          }

          await createPermanentNode(client, {
            name,
            remoteDir: opts.remoteDir,
            numExecutors: Number(opts.executors),
            labels: opts.labels,
            desc: opts.description,
            host: opts.host,
            port: Number(opts.port),
            credentialsId: opts.credId,
            javaPath: opts.javaPath,
            availability: opts.availability === "demand" ? "demand" : "always",
            inDemandDelay: Number(opts.inDemandDelay),
            idleDelay: Number(opts.idleDelay),
          });
          if (opts.availability !== "demand" && opts.availability !== "always") {
            printWarning(`WARN Unknown --availability '${opts.availability}'; defaulted to 'always'. Valid values: always | demand`);
          }
          trackResource("node", name, profile, client.baseUrl, dbPath);

          printSuccess(`OK Node '${name}' created.`);
          printMessage(`  Link: ${client.baseUrl.replace(/\/+$/, "")}/computer/${name}/`);
          if (opts.host) {
            printMessage(`  SSH Node will auto-connect to ${opts.host}:${opts.port} using cred: '${opts.credId || "None"}'`);
            if (!opts.credId) {
              printWarning(`WARN No SSH credential set — ensure key-based auth is configured on the agent.`);
            }
          } else {
            printMessage(`  Connect it via: Manage Jenkins -> Nodes -> ${name} -> Agent command`);
          }
        } catch (err) {
          printError(String(err instanceof Error ? err.message : err), err);
          process.exit(1);
        }
      },
    );

  // ── copy ──────────────────────────────────────────────────────────────────
  grp
    .command("copy")
    .argument("<source_name>")
    .argument("<new_name>")
    .description("Clone (duplicate) an existing node's configuration into a new node")
    .action(async (sourceName: string, newName: string) => {
      try {
        const client = await ctx.getClient({ useController: true });
        await copyNode(client, sourceName, newName);
        trackResource("node", newName, profile, client.baseUrl, dbPath);
        printSuccess(`OK Node '${newName}' created (copied from '${sourceName}').`);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── track ────────────────────────────────────────────────────────────────
  grp
    .command("track")
    .argument("<names...>")
    .description("Start tracking an existing node — pin it to your Mine (tracked nodes) for quick access (does not create)")
    .action(async (names: string[]) => {
      try {
        const client = await ctx.getClient({ useController: true });
        const tracked = getTrackedResources("node", profile, client.baseUrl, dbPath);
        const trackedSet = new Set(tracked);
        for (const name of names) {
          try {
            await getNode(client, name);
          } catch (e) {
            if (e instanceof NotFoundError) {
              printError(`Node '${name}' not found on server. Skipping.`);
              continue;
            }
            throw e;
          }
          if (trackedSet.has(name)) {
            printInfo(`INFO Node '${name}' is already tracked.`);
            continue;
          }
          trackResource("node", name, profile, client.baseUrl, dbPath);
          trackedSet.add(name);
          printSuccess(`OK Tracked node '${name}'.`);
        }
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── delete ────────────────────────────────────────────────────────────────
  grp
    .command("delete")
    .argument("<names...>")
    .option("--yes", "Skip confirmation", false)
    .description("Delete (remove / decommission / retire) one or more nodes (build agents / workers) permanently")
    .action(async (names: string[], opts: { yes: boolean }) => {
      try {
        if (!opts.yes) {
          const label = names.length === 1 ? `node '${names[0]}'` : `${names.length} nodes`;
          if (!(await confirm(`Delete ${label}? [y/N] `))) {
            printInfo("INFO Cancelled.");
            return;
          }
        }
        const client = await ctx.getClient({ useController: true });
        for (const name of names) {
          try {
            await deleteNode(client, name);
            untrackResource("node", name, profile, client.baseUrl, dbPath);
            printSuccess(`OK Node '${name}' deleted.`);
          } catch (e) {
            printError(`Failed to delete '${name}': ${e instanceof Error ? e.message : String(e)}`, e);
          }
        }
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── offline ─────────────────────────────────────────────────────────────────
  grp
    .command("offline")
    .argument("<name>")
    .option("--reason <reason>", "Reason for taking offline", "")
    .description("Take a node offline — stop builds on this agent, disable / suspend so it does not accept new builds (maintenance mode)")
    .action(async (name: string, opts: { reason: string }) => {
      try {
        const client = await ctx.getClient({ useController: true });
        const node = await getNode(client, name);
        if (node.offline) {
          printInfo(`INFO Node '${name}' is already offline.`);
          return;
        }
        await toggleOffline(client, name, opts.reason);
        printSuccess(`OK Node '${name}' marked offline.`);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── online ──────────────────────────────────────────────────────────────────
  grp
    .command("online")
    .argument("<name>")
    .description("Bring a node back online — allow builds again (enable / resume / reactivate this agent)")
    .action(async (name: string) => {
      try {
        const client = await ctx.getClient({ useController: true });
        const node = await getNode(client, name);
        if (!node.offline) {
          printInfo(`INFO Node '${name}' is already online.`);
          return;
        }
        await toggleOffline(client, name, "");
        printSuccess(`OK Node '${name}' brought online.`);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── untrack ─────────────────────────────────────────────────────────────────
  grp
    .command("untrack")
    .argument("<names...>")
    .description("Remove nodes from your Mine (tracked items) — does not delete from server")
    .action(async (names: string[]) => {
      try {
        const client = await ctx.getClient({ useController: true });
        const tracked = getTrackedResources("node", profile, client.baseUrl, dbPath);
        const trackedSet = new Set(tracked);
        for (const name of names) {
          if (!trackedSet.has(name)) {
            printInfo(`INFO Node '${name}' is not in Mine.`);
            continue;
          }
          untrackResource("node", name, profile, client.baseUrl, dbPath);
          trackedSet.delete(name);
          printSuccess(`OK Removed node '${name}' from Mine.`);
        }
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── update ──────────────────────────────────────────────────────────────────
  grp
    .command("update")
    .argument("<name>")
    .option("--description <desc>", "Human-readable description for this node")
    .option("--remote-dir <dir>", "Remote working directory on agent (e.g. /home/jenkins)")
    .option("--executors <n>", "Set number of executors (parallel build slots) — increase or decrease")
    .option("--labels <labels>", "Space-separated node labels (assign or change labels)")
    .option("--launcher <type>", "Launch method: ssh | jnlp")
    .option("--host <host>", "SSH host IP/hostname (ssh launcher)")
    .option("--port <n>", "SSH port (ssh launcher, default 22)")
    .option("--cred-id <id>", "Credential ID for SSH connection (ssh launcher)")
    .option("--java-path <path>", "Path to Java executable on agent (ssh launcher)")
    .option("--availability <mode>", "Retention/availability strategy: always | demand")
    .option("--in-demand-delay <min>", "Minutes of demand before bringing online (demand availability only)")
    .option("--idle-delay <min>", "Minutes idle before going offline (demand availability only)")
    .option("--controlled-agent <bool>", "Enable (true) or disable (false) Folders Plus controlled-agent mode for this node")
    .description("Edit (modify) a node's configuration: increase/decrease executor count, change labels, launcher, SSH host, remote dir, availability")
    .action(
      async (
        name: string,
        opts: {
          description?: string;
          remoteDir?: string;
          executors?: string;
          labels?: string;
          launcher?: string;
          host?: string;
          port?: string;
          credId?: string;
          javaPath?: string;
          availability?: string;
          inDemandDelay?: string;
          idleDelay?: string;
          controlledAgent?: string;
        },
      ) => {
        try {
          const client = await ctx.getClient({ useController: true });
          const launcherType =
            opts.launcher === "ssh" || opts.launcher === "jnlp" ? opts.launcher : undefined;
          if (opts.launcher !== undefined && launcherType === undefined) {
            printWarning(`WARN Unknown --launcher '${opts.launcher}'; ignored. Valid values: ssh | jnlp`);
          }
          const availability =
            opts.availability === "always" || opts.availability === "demand"
              ? opts.availability
              : undefined;
          if (opts.availability !== undefined && availability === undefined) {
            printWarning(`WARN Unknown --availability '${opts.availability}'; ignored. Valid values: always | demand`);
          }
          const controlledAgent =
            opts.controlledAgent === "true" ? true
            : opts.controlledAgent === "false" ? false
            : undefined;
          if (opts.controlledAgent !== undefined && controlledAgent === undefined) {
            printWarning(`WARN Unknown --controlled-agent '${opts.controlledAgent}'; ignored. Valid values: true | false`);
          }
          await updateNode(client, name, {
            desc: opts.description,
            remoteDir: opts.remoteDir,
            numExecutors: opts.executors !== undefined ? Number(opts.executors) : undefined,
            labels: opts.labels,
            launcherType,
            host: opts.host,
            port: opts.port !== undefined ? Number(opts.port) : undefined,
            credentialsId: opts.credId,
            javaPath: opts.javaPath,
            availability,
            inDemandDelay: opts.inDemandDelay !== undefined ? Number(opts.inDemandDelay) : undefined,
            idleDelay: opts.idleDelay !== undefined ? Number(opts.idleDelay) : undefined,
            controlledAgent,
          });
          printSuccess(`OK Node '${name}' updated.`);
          if (launcherType === "ssh" && opts.credId === "") {
            printWarning(`WARN SSH launcher with no credential set — ensure key-based auth is configured.`);
          }
        } catch (err) {
          printError(String(err instanceof Error ? err.message : err), err);
          process.exit(1);
        }
      },
    );
}
