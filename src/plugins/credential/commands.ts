/**
 * Credential plugin CLI commands — `bee cred ...`.
 * Ports legacy/cb/cli/commands/credentials.py with 1:1 behavior and strings.
 */
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { PluginContext } from "../../registry/types";
import { printError, printSuccess, printInfo, readHidden, tableFormatter } from "../../core/cli/output";
import { loadSession, getActiveProfileName } from "../../core/session/index";
import {
  getTrackedResources,
  trackResource,
  untrackResource,
} from "../../core/db/repositories/resource-repo";
import {
  CREDENTIAL_STORES,
  listCredentials,
  getCredential,
  createUsernamePassword,
  deleteCredential,
  updateCredential,
} from "./service";

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

/** Logged-in username from the session (empty if not logged in). */
function sessionUsername(dbPath?: string): string {
  try {
    return loadSession(dbPath)?.username ?? "";
  } catch {
    return "";
  }
}

function validateStore(store: string): void {
  if (!CREDENTIAL_STORES.includes(store as (typeof CREDENTIAL_STORES)[number])) {
    throw new Error(`Invalid store '${store}'. Choose from: ${CREDENTIAL_STORES.join(", ")}`);
  }
}

export function registerCredentialCommands(ctx: PluginContext): void {
  const dbPath = process.env["CB_DB_PATH"];
  const profile = getActiveProfileName(dbPath);

  const grp = ctx.program.command("cred").description("Manage CloudBees credentials");

  // ── list ────────────────────────────────────────────────────────────────────
  grp
    .command("list")
    .description("List credentials from the selected store")
    .option("-o, --output <fmt>", "Output format (table|json)", "table")
    .option("--all", "Show all credentials (by default, only shows yours)", false)
    .option("--store <store>", "Credential store: 'system' or 'user'", "system")
    .action(async (opts: { output: string; all: boolean; store: string }) => {
      try {
        validateStore(opts.store);
        const client = await ctx.getClient({ useController: true });
        const username = sessionUsername(dbPath);
        const allCreds = await listCredentials(client, username, opts.store);

        let creds = allCreds;
        if (!opts.all) {
          const tracked = getTrackedResources("credential", profile, client.baseUrl, dbPath);
          const trackedSet = new Set(tracked);
          const serverIds = new Set(allCreds.map((c) => c.id));
          creds = allCreds.filter((c) => trackedSet.has(c.id));
          for (const missing of trackedSet) {
            if (!serverIds.has(missing)) {
              creds.push({
                id: missing,
                displayName: "",
                typeName: "[DELETED]",
                scope: "",
                description: "[DELETED_ON_SERVER]",
              });
            }
          }
        }

        if (opts.output === "json") {
          console.log(JSON.stringify(creds, null, 2));
        } else {
          const headers = ["ID", "Type", "Description", "Scope"];
          const rows = creds.map((c) => [
            c.id,
            c.typeName.slice(0, 25),
            (c.description || "").slice(0, 35),
            c.scope,
          ]);
          const fmt = ctx.getFormatter("table") ?? tableFormatter;
          console.log(fmt.table(headers, rows));
          console.log(`  ${creds.length} credential(s)  [store: ${opts.store}]`);
        }
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── get ──────────────────────────────────────────────────────────────────────
  grp
    .command("get")
    .argument("<cred_id>")
    .description("Show credential details (secrets are masked)")
    .option("--store <store>", "Credential store: 'system' or 'user'", "system")
    .action(async (credId: string, opts: { store: string }) => {
      try {
        validateStore(opts.store);
        const client = await ctx.getClient({ useController: true });
        const cred = await getCredential(client, credId, sessionUsername(dbPath), opts.store);
        const data: Record<string, unknown> = { ...cred };
        for (const k of Object.keys(data)) {
          if (/(password|secret|key|token)/i.test(k)) data[k] = "[HIDDEN]";
        }
        const fmt = ctx.getFormatter("table") ?? tableFormatter;
        console.log(fmt.kv(data));
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── create ─────────────────────────────────────────────────────────────────
  grp
    .command("create")
    .description("Create a Username+Password credential")
    .option("--id <id>", "Unique credential ID (auto-generated if omitted)")
    .requiredOption("--username <username>", "Username")
    .option("--password <password>", "Password (prompted if omitted)")
    .option("--description <desc>", "Description", "")
    .option("--scope <scope>", "Credential scope (GLOBAL|SYSTEM)", "GLOBAL")
    .option("--store <store>", "Credential store: 'system' or 'user'", "system")
    .action(
      async (opts: {
        id?: string;
        username: string;
        password?: string;
        description: string;
        scope: string;
        store: string;
      }) => {
        try {
          validateStore(opts.store);
          const credId = opts.id || randomUUID();
          const password = opts.password ?? (await readHidden(`Password for '${opts.username}': `));

          const client = await ctx.getClient({ useController: true });
          const username = sessionUsername(dbPath);
          await createUsernamePassword(
            client,
            credId,
            opts.username,
            password,
            opts.description,
            opts.scope,
            username,
            opts.store,
          );
          trackResource("credential", credId, profile, client.baseUrl, dbPath);

          printSuccess(`OK Credential '${credId}' created in ${opts.store} store.`);
          const base = client.baseUrl.replace(/\/+$/, "");
          const url =
            opts.store === "user"
              ? `${base}/user/${username}/credentials/store/user/domain/_/credential/${credId}/`
              : `${base}/credentials/store/system/domain/_/credential/${credId}/`;
          console.log(`  Link: ${url}`);
        } catch (err) {
          printError(String(err instanceof Error ? err.message : err), err);
          process.exit(1);
        }
      },
    );

  // ── delete ────────────────────────────────────────────────────────────────
  grp
    .command("delete")
    .argument("<cred_id>")
    .option("--yes", "Skip confirmation", false)
    .option("--store <store>", "Credential store: 'system' or 'user'", "system")
    .description("Delete a credential")
    .action(async (credId: string, opts: { yes: boolean; store: string }) => {
      try {
        validateStore(opts.store);
        if (
          !opts.yes &&
          !(await confirm(`Delete credential '${credId}' from ${opts.store} store? [y/N] `))
        ) {
          console.log("Cancelled.");
          return;
        }
        const client = await ctx.getClient({ useController: true });
        await deleteCredential(client, credId, sessionUsername(dbPath), opts.store);
        untrackResource("credential", credId, profile, client.baseUrl, dbPath);
        printSuccess(`OK Credential '${credId}' deleted from ${opts.store} store.`);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── import ──────────────────────────────────────────────────────────────────
  grp
    .command("import")
    .argument("<cred_id>")
    .option("--store <store>", "Credential store: 'system' or 'user'", "system")
    .description("Track an existing server credential as yours (adds it to Mine)")
    .action(async (credId: string, opts: { store: string }) => {
      try {
        validateStore(opts.store);
        const client = await ctx.getClient({ useController: true });
        // Verify the credential exists on the server before tracking it.
        try {
          await getCredential(client, credId, sessionUsername(dbPath), opts.store);
        } catch (e) {
          const msg = String(e instanceof Error ? e.message : e);
          if (msg.includes("404")) {
            printError(`Credential '${credId}' not found in ${opts.store} store.`, e);
          } else {
            printError(`Could not verify credential '${credId}': ${msg}`, e);
          }
          process.exit(1);
        }
        const tracked = getTrackedResources("credential", profile, client.baseUrl, dbPath);
        if (tracked.includes(credId)) {
          printInfo(`INFO Credential '${credId}' is already imported.`);
          return;
        }
        trackResource("credential", credId, profile, client.baseUrl, dbPath);
        printSuccess(`OK Imported '${credId}' into Mine.`);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── update ──────────────────────────────────────────────────────────────────
  grp
    .command("update")
    .argument("<cred_id>")
    .option("--username-cred <username>", "New username or ID")
    .option("--password <password>", "New password")
    .option("--description <desc>", "New description")
    .option("--store <store>", "Which store (default: system)", "system")
    .description("Update an existing credential")
    .action(
      async (
        credId: string,
        opts: { usernameCred?: string; password?: string; description?: string; store: string },
      ) => {
        try {
          validateStore(opts.store);
          const client = await ctx.getClient({ useController: true });
          await updateCredential(
            client,
            credId,
            opts.usernameCred,
            opts.password,
            opts.description,
            sessionUsername(dbPath),
            opts.store,
          );
          printSuccess(`OK Credential '${credId}' updated.`);
        } catch (err) {
          printError(String(err instanceof Error ? err.message : err), err);
          process.exit(1);
        }
      },
    );
}
