#!/usr/bin/env bun
/**
 * bee — CloudBees CLI entry point.
 *
 * Bootstrap order: init DB → register all plugins onto the commander program → parse.
 */
import { Command } from "commander";
import { initDb } from "./core/db/connection";
import { initPlugins } from "./registry";
import { printError, setJsonOutput } from "./core/cli/output";
import { existsSync, chmodSync, mkdirSync, writeFileSync } from "fs";
import { symlinkSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

// Injected at build time via --define; falls back for `bun run` dev mode.
declare const BEE_VERSION: string | undefined;
const VERSION = typeof BEE_VERSION !== "undefined" ? BEE_VERSION : "0.3.0";

async function runInstall(): Promise<void> {
  // Only works from a compiled binary (not `bun run src/main.ts`).
  const binaryPath = process.execPath;
  const binaryDir = dirname(binaryPath);

  const wrapperPath = join(binaryDir, "bee.csh");
  const linkTarget = join(homedir(), ".local", "bin", "bee");

  // Write csh wrapper next to the binary.
  const wrapperContent = `#!/usr/bin/env csh\nexec "${binaryPath}" $*\n`;
  writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });
  chmodSync(wrapperPath, 0o755);
  console.log(`  [OK] wrapper: ${wrapperPath}`);

  // Create ~/.local/bin if missing.
  mkdirSync(join(homedir(), ".local", "bin"), { recursive: true });

  // Remove stale symlink or file at link target.
  if (existsSync(linkTarget)) {
    unlinkSync(linkTarget);
  }
  symlinkSync(wrapperPath, linkTarget);
  console.log(`  [OK] symlink: ${linkTarget} -> ${wrapperPath}`);
  console.log(`\nAdd ~/.local/bin to your PATH if not already present.`);
}

async function main(): Promise<void> {
  // --install: self-install without needing source or make.
  const argv = process.argv.slice(2);
  if (argv.includes("--install")) {
    await runInstall();
    return;
  }

  // 0. Global --json: machine-readable output for any command. Detected in argv
  //    (so it works in any position, e.g. `bee --json node list` or
  //    `bee node list --json`) and stripped before dispatch so subcommands that
  //    don't declare it won't reject it. Registered as a root option below only
  //    for --help visibility.
  if (argv.includes("--json")) {
    setJsonOutput(true);
    process.argv = process.argv.filter((a) => a !== "--json");
  }

  // 1. Ensure the local SQLite DB + schema exist.
  initDb();

  // 2. Build the root program.
  const program = new Command()
    .name("bee")
    .description("bee — CloudBees command-line tool")
    .version(VERSION, "-V, --version", "output the version number")
    .option("--json", "output machine-readable JSON instead of formatted text")
    .option("--debug", "enable debug logging and full stack traces")
    .option("--ui", "launch the interactive TUI")
    .option("--install", "install bee: create wrapper + symlink to ~/.local/bin/bee");

  // --debug toggles the env flag the output layer reads.
  program.on("option:debug", () => {
    process.env.BEE_DEBUG_TRACEBACK = "1";
  });

  // 3. Register every built-in plugin (compile-time registry).
  await initPlugins(program);

  // 4. `bee --ui` (or `bee` with no subcommand + --ui) launches the TUI.
  //    Checked before dispatch because a bare `--ui` has no subcommand to hook.
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
