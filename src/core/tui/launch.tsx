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

// Alternate screen buffer control (ncurses-style): enter on launch so the TUI
// owns the full terminal, leave on exit to restore the user's prior scrollback.
const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

// SGR mouse tracking disable sequences — sent on exit so the terminal doesn't
// stay in mouse-reporting mode after the TUI exits (otherwise every click after
// quitting would leak \x1b[<... escape sequences as visible characters).
const DISABLE_MOUSE = "\x1B[?1000l\x1B[?1002l\x1B[?1003l\x1B[?1006l";

export async function launchTui(dbPath?: string): Promise<void> {
  // Ink + React must run in production mode (the compiled binary has no JSX dev runtime).
  process.env.NODE_ENV ??= "production";

  // Enter the alternate screen. A guarded restore runs on normal exit and on any
  // abrupt termination (uncaught error, signal) so the terminal never stays stuck
  // on the blank alt-screen.
  let altScreenActive = false;
  const leaveAltScreen = (): void => {
    if (!altScreenActive) return;
    altScreenActive = false;
    process.stdout.write(LEAVE_ALT_SCREEN);
  };
  process.stdout.write(ENTER_ALT_SCREEN);
  altScreenActive = true;

  const onExit = (): void => {
    process.stdout.write(DISABLE_MOUSE);
    leaveAltScreen();
  };
  process.once("exit", onExit);

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

  // Drop only Ink's last frame on quit (it keeps it by default) so no stale TUI
  // frame lingers before we hand the terminal back.
  clear();

  // Leave the alternate screen → the user's pre-launch scrollback reappears intact.
  process.removeListener("exit", onExit);

  // Disable mouse tracking and leave alt-screen while stdout is still healthy.
  process.stdout.write(DISABLE_MOUSE);
  leaveAltScreen();
}
