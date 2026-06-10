#!/usr/bin/env bun
/**
 * bee — CloudBees CLI entry point.
 *
 * Bootstrap order: init DB → register all plugins onto the commander program → parse.
 */
import { Command } from "commander";
import { initDb } from "./core/db/connection";
import { initPlugins } from "./registry";
import { printError } from "./core/cli/output";

// Injected at build time via --define; falls back for `bun run` dev mode.
declare const BEE_VERSION: string | undefined;
const VERSION = typeof BEE_VERSION !== "undefined" ? BEE_VERSION : "0.3.0";

async function main(): Promise<void> {
  // 1. Ensure the local SQLite DB + schema exist.
  initDb();

  // 2. Build the root program.
  const program = new Command()
    .name("bee")
    .description("bee — CloudBees command-line tool")
    .version(VERSION, "-V, --version", "output the version number")
    .option("--debug", "enable debug logging and full stack traces")
    .option("--ui", "launch the interactive TUI");

  // --debug toggles the env flag the output layer reads.
  program.on("option:debug", () => {
    process.env.BEE_DEBUG_TRACEBACK = "1";
  });

  // 3. Register every built-in plugin (compile-time registry).
  await initPlugins(program);

  // 4. `bee --ui` (or `bee` with no subcommand + --ui) launches the TUI.
  //    Checked before dispatch because a bare `--ui` has no subcommand to hook.
  const argv = process.argv.slice(2);
  if (argv.includes("--ui")) {
    const { launchTui } = await import("./core/tui/launch");
    await launchTui(process.env.CB_DB_PATH);
    return;
  }

  // 5. Parse & dispatch. Show help when invoked with no subcommand.
  if (argv.length === 0) {
    program.outputHelp();
    return;
  }
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  printError("Command failed", err);
  process.exit(1);
});
