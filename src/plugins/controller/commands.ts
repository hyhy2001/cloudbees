/**
 * Controller CLI commands — bee controller list/info/select/current.
 * Ports legacy/cb/cli/commands/controller.py
 */

import type { PluginContext } from "../../registry/types";
import { printSuccess, printError, tableFormatter } from "../../core/cli/output";
import { CloudBeesClientImpl } from "../../core/api/index";
import {
  listControllers,
  selectController,
  resolveControllerUrl,
  getActiveController,
  getControllerCapabilities,
} from "./service";

export function registerControllerCommands(ctx: PluginContext): void {
  const dbPath = process.env["CB_DB_PATH"];

  const grp = ctx.program
    .command("controller")
    .description("Select and manage CloudBees controllers");

  // ── list ───────────────────────────────────────────────────────────────────
  grp
    .command("list")
    .description("List all controllers on this CloudBees server")
    .action(async () => {
      try {
        const client = await ctx.getClient({ useController: false });
        const controllers = await listControllers(client);
        const active = getActiveController(dbPath);
        const activeName = active ? active[0] : null;

        const formatter = ctx.getFormatter("table") ?? tableFormatter;
        const rows = controllers.map((c) => [
          c.name === activeName ? "*" : "",
          c.name,
          (c.description ?? "").slice(0, 40),
          c.online ? "ONLINE" : "OFFLINE",
        ]);
        console.log(formatter.table(["Active", "Name", "Description", "Status"], rows));
        console.log(`  ${controllers.length} controller(s)`);
      } catch (err) {
        printError("Failed to list controllers", err);
        process.exit(1);
      }
    });

  // ── info ───────────────────────────────────────────────────────────────────
  grp
    .command("info")
    .description("Show controller details and creation permissions")
    .argument("<name>", "Controller name")
    .action(async (name: string) => {
      try {
        const client = await ctx.getClient({ useController: false });
        // Extract raw token for capability probing
        const rawToken = client instanceof CloudBeesClientImpl ? client.token : "";
        const caps = await getControllerCapabilities(client, name, rawToken);

        const formatter = ctx.getFormatter("table") ?? tableFormatter;
        console.log(
          formatter.kv({
            name: caps.name,
            url: caps.url,
            typeLabel: caps.typeLabel,
            online: caps.online,
            canCreateJob: caps.canCreateJob,
            canCreateNode: caps.canCreateNode,
            canCreateCred: caps.canCreateCred,
            description: caps.description,
          }),
        );
      } catch (err) {
        printError("Failed to get controller info", err);
        process.exit(1);
      }
    });

  // ── select ─────────────────────────────────────────────────────────────────
  grp
    .command("select")
    .description("Set the active controller for subsequent commands")
    .argument("<name>", "Controller name")
    .action(async (name: string) => {
      try {
        const client = await ctx.getClient({ useController: false });
        const controllers = await listControllers(client);
        const match = controllers.find((c) => c.name === name);
        if (!match) {
          printError(`Controller '${name}' not found.`);
          process.exit(1);
        }

        const url = await resolveControllerUrl(client, match.url);
        selectController(match.name, url, dbPath);
        printSuccess(`OK Active controller: ${match.name}`);
        console.log(`     Resolved URL: ${url}`);
      } catch (err) {
        printError("Failed to select controller", err);
        process.exit(1);
      }
    });

  // ── current ────────────────────────────────────────────────────────────────
  grp
    .command("current")
    .description("Show the currently active controller")
    .action(() => {
      const active = getActiveController(dbPath);
      if (active) {
        console.log(`Active controller: ${active[0]}`);
        console.log(`URL              : ${active[1]}`);
      } else {
        console.log("No active controller selected. Use: bee controller select <name>");
      }
    });
}
