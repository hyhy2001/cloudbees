/**
 * Controller CLI commands — bee controller list/info/select/current.
 * Ports legacy/cb/cli/commands/controller.py
 */

import type { PluginContext } from "../../registry/types";
import { printSuccess, printError, printInfo, printMessage, tableFormatter, isJsonOutput, printJson } from "../../core/cli/output";
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
    .description("Manage CloudBees / Jenkins controller instances (masters)");

  // ── list ───────────────────────────────────────────────────────────────────
  grp
    .command("list")
    .description("List all available controllers (instances / masters) on this CloudBees server")
    .action(async () => {
      try {
        const client = await ctx.getClient({ useController: false });
        const controllers = await listControllers(client);
        const active = getActiveController(dbPath);
        const activeName = active ? active[0] : null;

        if (isJsonOutput()) {
          printJson(
            controllers.map((c) => ({
              name: c.name,
              description: c.description ?? "",
              online: c.online,
              active: c.name === activeName,
            })),
          );
          return;
        }

        const formatter = ctx.getFormatter("table") ?? tableFormatter;
        const rows = controllers.map((c) => [
          c.name === activeName ? "*" : "",
          c.name,
          (c.description ?? "").slice(0, 40),
          c.online ? "ONLINE" : "OFFLINE",
        ]);
        printMessage(formatter.table(["Active", "Name", "Description", "Status"], rows));
        printMessage(`  ${controllers.length} controller(s)`);
      } catch (err) {
        printError("Failed to list controllers", err);
        process.exit(1);
      }
    });

  // ── info ───────────────────────────────────────────────────────────────────
  grp
    .command("info")
    .description("View / inspect controller details: URL, type, online status, creation permissions")
    .argument("<name>", "Controller name")
    .action(async (name: string) => {
      try {
        const client = await ctx.getClient({ useController: false });
        // Extract raw token for capability probing
        const rawToken = client instanceof CloudBeesClientImpl ? client.token : "";
        const caps = await getControllerCapabilities(client, name, rawToken);

        const info = {
          name: caps.name,
          url: caps.url,
          typeLabel: caps.typeLabel,
          online: caps.online,
          canCreateJob: caps.canCreateJob,
          canCreateNode: caps.canCreateNode,
          canCreateCred: caps.canCreateCred,
          description: caps.description,
        };
        if (isJsonOutput()) {
          printJson(info);
          return;
        }
        const formatter = ctx.getFormatter("table") ?? tableFormatter;
        printMessage(formatter.kv(info));
      } catch (err) {
        printError("Failed to get controller info", err);
        process.exit(1);
      }
    });

  // ── select ─────────────────────────────────────────────────────────────────
  grp
    .command("select")
    .description("Switch / change the active controller (master / instance) for all subsequent commands")
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
        printMessage(`     Resolved URL: ${url}`);
      } catch (err) {
        printError("Failed to select controller", err);
        process.exit(1);
      }
    });

  // ── current ────────────────────────────────────────────────────────────────
  grp
    .command("current")
    .description("Show which controller is currently active (selected instance / master)")
    .action(() => {
      const active = getActiveController(dbPath);
      if (isJsonOutput()) {
        printJson(active ? { name: active[0], url: active[1] } : null);
        return;
      }
      if (active) {
        printMessage(`Active controller: ${active[0]}`);
        printMessage(`URL              : ${active[1]}`);
      } else {
        printInfo("INFO No active controller selected. Use: bee controller select <name>");
      }
    });
}
