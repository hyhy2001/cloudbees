/**
 * Node plugin CLI commands — `bee node ...`.
 * Ports legacy/cb/cli/commands/nodes.py with 1:1 behavior and strings.
 */
import readline from "node:readline";
import type { PluginContext } from "../../registry/types";
import { printError, printInfo, printSuccess, tableFormatter } from "../../core/cli/output";
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
} from "./service";

const DEFAULT_JAVA_PATH = "/usr/local/java/openjdk-19.0.2-7/bin/java";

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

export function registerNodeCommands(ctx: PluginContext): void {
  const dbPath = process.env["CB_DB_PATH"];
  const profile = "default";

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
            if (!msg.includes("404") && !msg.includes("not found")) throw e;
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
        await toggleOffline(client, name, opts.reason);
        printSuccess(`OK Node '${name}' toggled offline.`);
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
        await toggleOffline(client, name, "");
        printSuccess(`OK Node '${name}' toggled online.`);
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
    .description("Update a node's configuration")
    .action(
      async (
        name: string,
        opts: { description?: string; remoteDir?: string; executors?: string; labels?: string },
      ) => {
        try {
          const client = await ctx.getClient({ useController: true });
          await updateNode(client, name, {
            desc: opts.description,
            remoteDir: opts.remoteDir,
            numExecutors: opts.executors !== undefined ? Number(opts.executors) : undefined,
            labels: opts.labels,
          });
          printSuccess(`OK Node '${name}' updated.`);
        } catch (err) {
          printError(String(err instanceof Error ? err.message : err), err);
          process.exit(1);
        }
      },
    );
}
