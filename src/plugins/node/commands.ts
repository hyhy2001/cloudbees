/**
 * Node plugin CLI commands — `bee node ...`.
 * Ports legacy/cb/cli/commands/nodes.py with 1:1 behavior and strings.
 */
import type { PluginContext } from "../../registry/types";
import { printError, printInfo, printSuccess, tableFormatter } from "../../core/cli/output";
import { confirm } from "../../core/cli/utils";
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

  const grp = ctx.program.command("node").description("Manage CloudBees agent nodes");

  // ── list ────────────────────────────────────────────────────────────────────
  grp
    .command("list")
    .description("List agent nodes with online/offline status")
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
        console.log(tableFormatter.table(headers, rows));
        console.log(`  ${nodes.length} node(s)`);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── get ──────────────────────────────────────────────────────────────────────
  grp
    .command("get")
    .argument("<name>")
    .description("Show node details")
    .action(async (name: string) => {
      try {
        const client = await ctx.getClient({ useController: true });
        const node = await getNode(client, name);
        console.log(
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
    .description("Create a Permanent Agent (SSH or JNLP launcher)")
    .requiredOption("--name <name>", "Node name")
    .requiredOption("--remote-dir <dir>", "Remote work directory (e.g. /home/jenkins)")
    .option("--executors <n>", "Number of executors", "1")
    .option("--labels <labels>", "Space-separated labels", "")
    .option("--description <desc>", "Description", "")
    .option("--host <host>", "SSH Host IP/Hostname (if omitted, creates JNLP/Inbound agent)", "")
    .option("--port <port>", "SSH Port", "22")
    .option("--cred-id <id>", "Credential ID for SSH connection", "")
    .option("--java-path <path>", "Path to Java executable", DEFAULT_JAVA_PATH)
    .option("--availability <mode>", "Retention strategy: always | demand", "always")
    .option("--in-demand-delay <min>", "Minutes of demand before going online (demand only)", "0")
    .option("--idle-delay <min>", "Minutes idle before going offline (demand only)", "1")
    .action(
      async (opts: {
        name: string;
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
      }) => {
        try {
          const client = await ctx.getClient({ useController: true });

          // Skip if the node already exists (mirrors Python's pre-check).
          try {
            await getNode(client, opts.name);
            printInfo(`INFO Node '${opts.name}' already exists.`);
            return;
          } catch (e) {
            const msg = String(e instanceof Error ? e.message : e).toLowerCase();
            if (!(e instanceof NotFoundError) && !msg.includes("not found")) throw e;
          }

          await createPermanentNode(client, {
            name: opts.name,
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
          trackResource("node", opts.name, profile, client.baseUrl, dbPath);

          printSuccess(`OK Node '${opts.name}' created.`);
          console.log(`  Link: ${client.baseUrl.replace(/\/+$/, "")}/computer/${opts.name}/`);
          if (opts.host) {
            console.log(
              `  SSH Node will auto-connect to ${opts.host}:${opts.port} using cred: '${opts.credId || "None"}'`,
            );
          } else {
            console.log(
              `  Connect it via: Manage Jenkins -> Nodes -> ${opts.name} -> Agent command`,
            );
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
    .description("Copy an existing node's configuration to a new node")
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

  // ── import ────────────────────────────────────────────────────────────────
  grp
    .command("import")
    .argument("<name>")
    .description("Track an existing server node as yours (adds it to your Mine list)")
    .action(async (name: string) => {
      try {
        const client = await ctx.getClient({ useController: true });
        try {
          await getNode(client, name);
        } catch (e) {
          if (e instanceof NotFoundError) {
            printError(`Node '${name}' not found on server. Nothing to import.`);
            process.exit(1);
          }
          throw e;
        }
        const tracked = getTrackedResources("node", profile, client.baseUrl, dbPath);
        if (tracked.includes(name)) {
          printInfo(`INFO Node '${name}' is already imported.`);
          return;
        }
        trackResource("node", name, profile, client.baseUrl, dbPath);
        printSuccess(`OK Imported node '${name}' into your Mine list.`);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── delete ────────────────────────────────────────────────────────────────
  grp
    .command("delete")
    .argument("<name>")
    .option("--yes", "Skip confirmation", false)
    .description("Delete a node")
    .action(async (name: string, opts: { yes: boolean }) => {
      try {
        if (!opts.yes && !(await confirm(`Delete node '${name}'? [y/N] `))) {
          console.log("Cancelled.");
          return;
        }
        const client = await ctx.getClient({ useController: true });
        await deleteNode(client, name);
        untrackResource("node", name, profile, client.baseUrl, dbPath);
        printSuccess(`OK Node '${name}' deleted.`);
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
    .description("Mark a node as offline")
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
    .description("Bring a node back online (toggle offline off)")
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

  // ── update ──────────────────────────────────────────────────────────────────
  grp
    .command("update")
    .argument("<name>")
    .option("--description <desc>", "Node description")
    .option("--remote-dir <dir>", "Remote root directory (e.g. /home/jenkins)")
    .option("--executors <n>", "Number of executors")
    .option("--labels <labels>", "Labels (space separated)")
    .option("--launcher <type>", "Launch method: ssh or jnlp")
    .option("--host <host>", "SSH host (ssh launcher)")
    .option("--port <n>", "SSH port (ssh launcher, default 22)")
    .option("--cred-id <id>", "SSH credentials ID (ssh launcher)")
    .option("--java-path <path>", "Java path (ssh launcher)")
    .option("--availability <mode>", "Availability: always or demand")
    .option("--in-demand-delay <n>", "Minutes of demand before going online (demand)")
    .option("--idle-delay <n>", "Minutes idle before going offline (demand)")
    .description("Update a node's configuration")
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
        },
      ) => {
        try {
          const client = await ctx.getClient({ useController: true });
          const launcherType =
            opts.launcher === "ssh" || opts.launcher === "jnlp" ? opts.launcher : undefined;
          const availability =
            opts.availability === "always" || opts.availability === "demand"
              ? opts.availability
              : undefined;
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
          });
          printSuccess(`OK Node '${name}' updated.`);
        } catch (err) {
          printError(String(err instanceof Error ? err.message : err), err);
          process.exit(1);
        }
      },
    );
}
