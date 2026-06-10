/**
 * Authenticated client factory — the one cross-cutting concern shared by every plugin.
 *
 * Mirrors legacy/cb/services/auth_service.get_client(): load the saved session, and
 * (when useController) rebase the client onto the active controller's URL so that
 * subsequent API calls hit the controller namespace rather than the server root.
 *
 * This lives in core (not the auth plugin) because the PluginContext passed to every
 * plugin needs it, and core must never import from plugins/. The auth *plugin* owns
 * login/logout/profile commands; constructing a client from an existing session is a
 * core capability.
 */
import { CloudBeesClientImpl } from "./api/client";
import type { CloudBeesClient } from "./api/types";
import { AuthError } from "./api/errors";
import { loadSession } from "./session/session";
import { getSetting } from "./db/repositories/settings-repo";
import type { GetClientOptions } from "../registry/types";

/** Active controller as [name, url], or null if none selected. */
export function getActiveController(dbPath?: string): [string, string] | null {
  const name = getSetting("active_controller", dbPath);
  if (!name) return null;
  const url = getSetting("active_controller_url", dbPath) ?? `/cjoc/job/${name}/`;
  return [name, url];
}

/**
 * Build an authenticated CloudBeesClient from the saved session.
 * When `useController` is true (default), the base URL is the active controller's URL.
 */
export function getClient(opts: GetClientOptions & { dbPath?: string } = {}): CloudBeesClient {
  const { useController = true, dbPath } = opts;
  const session = loadSession(dbPath);
  if (!session || !session.serverUrl) {
    throw new AuthError("Not logged in or session expired. Run: bee auth login");
  }

  let baseUrl = session.serverUrl;
  if (useController) {
    const active = getActiveController(dbPath);
    if (active && active[1]) baseUrl = active[1];
  }

  return new CloudBeesClientImpl(baseUrl, session.rawToken, { dbPath });
}
