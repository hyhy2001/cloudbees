/**
 * Credential plugin CLI commands — `bee cred ...`.
 * Ports legacy/cb/cli/commands/credentials.py with 1:1 behavior and strings.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "../../registry/types";
import { printError, printSuccess, printInfo, printWarning, printMessage, readHidden, tableFormatter } from "../../core/cli/output";
import { confirm } from "../../core/cli/utils";
import { NotFoundError, ValidationError } from "../../core/api/errors";
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
  createSecretText,
  deleteCredential,
  updateCredential,
} from "./service";


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
    throw new ValidationError(`Invalid store '${store}'. Choose from: ${CREDENTIAL_STORES.join(", ")}`);
  }
}

const CREDENTIAL_SCOPES = ["GLOBAL", "SYSTEM"] as const;

function validateScope(scope: string): void {
  if (!CREDENTIAL_SCOPES.includes(scope as (typeof CREDENTIAL_SCOPES)[number])) {
    throw new ValidationError(`Invalid scope '${scope}'. Choose from: ${CREDENTIAL_SCOPES.join(", ")}`);
  }
}

/**
 * `--store user` resolves to `/user/<username>/...`, but getUserSeg silently
 * falls back to the system store when no username is available (logged out).
 * Warn the user so they know they're operating on `system`, not `user`.
 */
function warnUserStoreFallback(store: string, dbPath?: string): void {
  if (store === "user" && !sessionUsername(dbPath)) {
    printWarning("WARN --store user requested but not logged in; using the system store.");
  }
}

export function registerCredentialCommands(ctx: PluginContext): void {
  const dbPath = process.env["CB_DB_PATH"];
  const profile = getActiveProfileName(dbPath);

  const grp = ctx.program.command("cred").description("Manage CloudBees credentials (secrets, tokens, passwords, API keys, SSH keys)");

  // ── list ────────────────────────────────────────────────────────────────────
  grp
    .command("list")
    .description("List stored credentials (secrets, tokens, passwords) from the selected store")
    .option("-o, --output <fmt>", "Output format (table|json)", "table")
    .option("--all", "Show all credentials (by default, only shows yours)", false)
    .option("--store <store>", "Credential store to list from: 'system' (default) or 'user'", "system")
    .action(async (opts: { output: string; all: boolean; store: string }) => {
      try {
        validateStore(opts.store);
        warnUserStoreFallback(opts.store, dbPath);
        const client = await ctx.getClient({ useController: true });
        const username = sessionUsername(dbPath);
        const allCreds = await listCredentials(client, username, opts.store);

        let creds = allCreds;
        if (!opts.all) {
          const tracked = getTrackedResources("credential", profile, `${client.baseUrl}.${opts.store}`, dbPath);
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
          printMessage(JSON.stringify(creds, null, 2));
        } else {
          const headers = ["ID", "Type", "Description", "Scope"];
          const rows = creds.map((c) => [
            c.id,
            c.typeName.slice(0, 25),
            (c.description || "").slice(0, 35),
            c.scope,
          ]);
          const fmt = ctx.getFormatter("table") ?? tableFormatter;
          printMessage(fmt.table(headers, rows));
          printMessage(`  ${creds.length} credential(s)  [store: ${opts.store}]`);
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
    .description("View / inspect a credential's details (secret values are masked)")
    .option("--store <store>", "Credential store: 'system' (default) or 'user'", "system")
    .action(async (credId: string, opts: { store: string }) => {
      try {
        validateStore(opts.store);
        warnUserStoreFallback(opts.store, dbPath);
        const client = await ctx.getClient({ useController: true });
        const cred = await getCredential(client, credId, sessionUsername(dbPath), opts.store);
        const data: Record<string, unknown> = { ...cred };
        for (const k of Object.keys(data)) {
          if (/(password|secret|key|token)/i.test(k)) data[k] = "[HIDDEN]";
        }
        const fmt = ctx.getFormatter("table") ?? tableFormatter;
        printMessage(fmt.kv(data));
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── create ─────────────────────────────────────────────────────────────────
  grp
    .command("create")
    .description("Save / create a new credential (with optional custom --id): Username+Password, API token, SSH key, or plain secret text")
    .option("--id <id>", "Unique credential ID (auto-generated if omitted)")
    .option("--username <username>", "Username — creates a Username+Password credential")
    .option("--password <password>", "Password or API key (prompted securely if omitted)")
    .option("--secret-text <secret>", "Plain-text secret value (token, API key) — creates SecretText type")
    .option("--description <desc>", "Human-readable label for this credential", "")
    .option("--scope <scope>", "Visibility: GLOBAL (default, all jobs) or SYSTEM (server admin only)", "GLOBAL")
    .option("--store <store>", "Credential store: 'system' (default) or 'user'", "system")
    .action(
      async (opts: {
        id?: string;
        username?: string;
        password?: string;
        secretText?: string;
        description: string;
        scope: string;
        store: string;
      }) => {
        try {
          validateStore(opts.store);
          warnUserStoreFallback(opts.store, dbPath);
          validateScope(opts.scope);
          const credId = opts.id || randomUUID();

          if (opts.secretText !== undefined && opts.username !== undefined) {
            throw new ValidationError("--secret-text and --username are mutually exclusive.");
          }

          const client = await ctx.getClient({ useController: true });
          const username = sessionUsername(dbPath);

          if (opts.secretText !== undefined) {
            await createSecretText(
              client,
              credId,
              opts.secretText,
              opts.description,
              opts.scope,
              username,
              opts.store,
            );
          } else {
            if (!opts.username) {
              throw new ValidationError("--username is required for Username+Password credentials (or use --secret-text for SecretText).");
            }
            const password = opts.password ?? (await readHidden(`Password for '${opts.username}': `));
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
          }
          trackResource("credential", credId, profile, `${client.baseUrl}.${opts.store}`, dbPath);

          printSuccess(`OK Credential '${credId}' created in ${opts.store} store.`);
          const base = client.baseUrl.replace(/\/+$/, "");
          const url =
            opts.store === "user"
              ? `${base}/user/${username}/credentials/store/user/domain/_/credential/${credId}/`
              : `${base}/credentials/store/system/domain/_/credential/${credId}/`;
          printMessage(`  Link: ${url}`);
        } catch (err) {
          printError(String(err instanceof Error ? err.message : err), err);
          process.exit(1);
        }
      },
    );

  // ── delete ────────────────────────────────────────────────────────────────
  grp
    .command("delete")
    .argument("<cred_ids...>")
    .option("--yes", "Skip confirmation prompt", false)
    .option("--store <store>", "Which credential store to delete from: 'system' (default) or 'user' store", "system")
    .description("Delete (remove / revoke / expire) one or more credentials from the system or user store (secrets, tokens, API keys, passwords) permanently")
    .action(async (credIds: string[], opts: { yes: boolean; store: string }) => {
      try {
        validateStore(opts.store);
        warnUserStoreFallback(opts.store, dbPath);
        if (!opts.yes) {
          const label = credIds.length === 1 ? `credential '${credIds[0]}'` : `${credIds.length} credentials`;
          if (!(await confirm(`Delete ${label} from ${opts.store} store? [y/N] `))) {
            printInfo("INFO Cancelled.");
            return;
          }
        }
        const client = await ctx.getClient({ useController: true });
        for (const credId of credIds) {
          try {
            await deleteCredential(client, credId, sessionUsername(dbPath), opts.store);
            untrackResource("credential", credId, profile, `${client.baseUrl}.${opts.store}`, dbPath);
            printSuccess(`OK Credential '${credId}' deleted from ${opts.store} store.`);
          } catch (e) {
            printError(`Failed to delete '${credId}': ${e instanceof Error ? e.message : String(e)}`, e);
          }
        }
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── track ──────────────────────────────────────────────────────────────────
  grp
    .command("track")
    .argument("<cred_ids...>")
    .option("--store <store>", "Credential store: 'system' (default) or 'user'", "system")
    .description("Track / follow / pin existing server credentials — add them to your Mine for quick access (does not create)")
    .action(async (credIds: string[], opts: { store: string }) => {
      try {
        validateStore(opts.store);
        warnUserStoreFallback(opts.store, dbPath);
        const client = await ctx.getClient({ useController: true });
        const tracked = getTrackedResources("credential", profile, `${client.baseUrl}.${opts.store}`, dbPath);
        const trackedSet = new Set(tracked);
        for (const credId of credIds) {
          // Verify the credential exists on the server before tracking it.
          try {
            await getCredential(client, credId, sessionUsername(dbPath), opts.store);
          } catch (e) {
            if (e instanceof NotFoundError) {
              printError(`Credential '${credId}' not found in ${opts.store} store. Skipping.`, e);
            } else {
              const msg = e instanceof Error ? e.message : String(e);
              printError(`Could not verify credential '${credId}': ${msg}`, e);
            }
            continue;
          }
          if (trackedSet.has(credId)) {
            printInfo(`INFO Credential '${credId}' is already tracked.`);
            continue;
          }
          trackResource("credential", credId, profile, `${client.baseUrl}.${opts.store}`, dbPath);
          trackedSet.add(credId);
          printSuccess(`OK Tracked '${credId}' into Mine.`);
        }
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });

  // ── update ──────────────────────────────────────────────────────────────────
  grp
    .command("update")
    .argument("<cred_id>")
    .option("--username <username>", "New username value")
    .option("--password <password>", "New password or API key (Username+Password credentials)")
    .option("--secret-text <secret>", "New secret value — rotate / refresh the stored token or key")
    .option("--description <desc>", "New human-readable label")
    .option("--store <store>", "Credential store: 'system' (default) or 'user'", "system")
    .description("Update (edit / rotate) an existing credential — change password, API token, secret value, or description")
    .action(
      async (
        credId: string,
        opts: { username?: string; password?: string; secretText?: string; description?: string; store: string },
      ) => {
        try {
          validateStore(opts.store);
          warnUserStoreFallback(opts.store, dbPath);
          if (opts.password !== undefined && opts.secretText !== undefined) {
            throw new ValidationError("--password and --secret-text are mutually exclusive.");
          }
          const client = await ctx.getClient({ useController: true });
          await updateCredential(
            client,
            credId,
            opts.username,
            opts.password ?? opts.secretText,
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

  // ── untrack ─────────────────────────────────────────────────────────────────
  grp
    .command("untrack")
    .argument("<cred_ids...>")
    .option("--store <store>", "Credential store: 'system' (default) or 'user'", "system")
    .description("Stop tracking credentials — remove from your Mine (does not delete from server)")
    .action(async (credIds: string[], opts: { store: string }) => {
      try {
        validateStore(opts.store);
        const client = await ctx.getClient({ useController: true });
        const tracked = getTrackedResources("credential", profile, `${client.baseUrl}.${opts.store}`, dbPath);
        const trackedSet = new Set(tracked);
        for (const credId of credIds) {
          if (!trackedSet.has(credId)) {
            printInfo(`INFO Credential '${credId}' is not in Mine.`);
            continue;
          }
          untrackResource("credential", credId, profile, `${client.baseUrl}.${opts.store}`, dbPath);
          trackedSet.delete(credId);
          printSuccess(`OK Removed '${credId}' from Mine.`);
        }
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });
}
