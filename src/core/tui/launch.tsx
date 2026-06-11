/**
 * TUI bootstrap — wire session + screens and render <BeeApp>.
 * Called from main.ts when `--ui` is passed.
 */

import React from "react";
import { render } from "ink";
import { BeeApp } from "./app";
import { TuiProvider } from "./context";
import { collectScreens } from "../../registry/tui";
import { loadSession, getActiveProfileName } from "../session/session";
import { getActiveController } from "../client-factory";

export async function launchTui(dbPath?: string): Promise<void> {
  // Ink + React must run in production mode (the compiled binary has no JSX dev runtime).
  process.env.NODE_ENV ??= "production";

  const session = loadSession(dbPath);
  const active = getActiveController(dbPath);

  const initialSession = {
    username: session?.username ?? "",
    activeController: active ? active[0] : null,
    loggedIn: session !== null,
    profile: getActiveProfileName(dbPath),
  };

  const screens = collectScreens();

  const { waitUntilExit, clear } = render(
    <TuiProvider initialSession={initialSession} dbPath={dbPath}>
      <BeeApp screens={screens} />
    </TuiProvider>,
  );

  await waitUntilExit();

  // Leave a clean terminal on quit: Ink keeps its last frame by default. clear()
  // drops Ink's own output; the escape also wipes scrollback (\x1b[3J) and homes
  // the cursor so no stale TUI frame lingers in the user's shell.
  clear();
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}
