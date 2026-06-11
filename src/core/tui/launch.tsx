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

  const { waitUntilExit } = render(
    <TuiProvider initialSession={initialSession} dbPath={dbPath}>
      <BeeApp screens={screens} />
    </TuiProvider>,
  );

  await waitUntilExit();
}
