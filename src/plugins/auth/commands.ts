/**
 * Auth CLI commands — bee auth login/logout/delete/profiles.
 * Ports legacy/cb/cli/commands/auth.py.
 */

import type { PluginContext } from "../../registry/types";
import { printSuccess, printError, tableFormatter } from "../../core/cli/output";
import { login, logout, deleteProfile, listProfiles } from "./service";

/**
 * Read a line from stdin with echo disabled (hidden input for token).
 * Falls back to a visible prompt if raw-mode is unavailable.
 */
async function readHidden(promptText: string): Promise<string> {
  process.stderr.write(promptText);
  // Use stty to disable echo, read one line, then restore
  const proc = Bun.spawn(["bash", "-c", "stty -echo; read line; stty echo; echo \"$line\""], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(proc.stdout).text();
  process.stderr.write("\n");
  return output.trimEnd();
}

export function registerAuthCommands(ctx: PluginContext): void {
  const dbPath = process.env["CB_DB_PATH"];

  const grp = ctx.program
    .command("auth")
    .description("Authentication and profile management");

  // ── login ──────────────────────────────────────────────────────────────────
  grp
    .command("login")
    .description("Login to a CloudBees server and save API Token")
    .option("--url <url>", "CloudBees server URL")
    .option("--username <username>", "Your username")
    .option("--token <token>", "Your API Token")
    .option("--profile <profile>", "Profile name", "default")
    .action(async (opts: { url?: string; username?: string; token?: string; profile: string }) => {
      try {
        let url = opts.url;
        let username = opts.username;
        let token = opts.token;

        if (!url) {
          process.stdout.write("Server URL: ");
          url = prompt("") ?? "";
        }
        if (!username) {
          process.stdout.write("Username: ");
          username = prompt("") ?? "";
        }
        if (!token) {
          token = await readHidden("API Token: ");
        }

        if (!url || !username || !token) {
          printError("url, username, and token are all required.");
          process.exit(1);
        }

        const p = await login(url, username, token, opts.profile, true, dbPath);
        printSuccess(`OK Logged in as '${p.username}' on ${p.serverUrl}`);
        console.log(`     Profile: ${p.name}`);
      } catch (err) {
        printError("Login failed", err);
        process.exit(1);
      }
    });

  // ── logout ─────────────────────────────────────────────────────────────────
  grp
    .command("logout")
    .description("Remove stored token for a profile")
    .option("--profile <profile>", "Profile to logout (default: active)")
    .action((opts: { profile?: string }) => {
      logout(opts.profile, dbPath);
      printSuccess("OK Logged out.");
    });

  // ── delete ─────────────────────────────────────────────────────────────────
  grp
    .command("delete")
    .description("Delete a saved profile")
    .requiredOption("--profile <profile>", "Profile name to delete")
    .action((opts: { profile: string }) => {
      try {
        deleteProfile(opts.profile, dbPath);
        printSuccess(`OK Profile '${opts.profile}' deleted.`);
      } catch (err) {
        printError(`Failed to delete profile`, err);
        process.exit(1);
      }
    });

  // ── profiles ───────────────────────────────────────────────────────────────
  grp
    .command("profiles")
    .description("List all saved profiles")
    .action(() => {
      const profiles = listProfiles(dbPath);
      if (profiles.length === 0) {
        console.log("No profiles found. Run: bee auth login");
        return;
      }
      const rows = profiles.map((p) => [
        p.name,
        p.serverUrl,
        p.username,
        p.isDefault ? "*" : "",
      ]);
      const formatter = ctx.getFormatter("table") ?? tableFormatter;
      console.log(formatter.table(["Profile", "Server", "Username", "Default"], rows));
    });
}
