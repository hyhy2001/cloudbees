import React, { useState } from "react";
import { Box, Text, useApp } from "ink";
import type { TuiScreen } from "../../registry/types";
import { useTui } from "./context";
import { SYM } from "./symbols";
import { THEME } from "./theme";
import { Toast } from "./components/Toast";
import { StatusBar } from "./components/StatusBar";
import { CommandLog } from "./components/CommandLog";
import { FormModal } from "./components/FormModal";
import { useKeymap, type KeyBinding } from "./keymap";
import { useDimensions } from "./data/use-dimensions";
import { listProfiles } from "../db/repositories/profile-repo";

export interface BeeAppProps {
  screens: TuiScreen[];
}

// Global hints shown on the right side of the status bar, always visible.
const GLOBAL_HINTS = [
  { key: "←→/Tab", label: "tab" },
  { key: "L", label: "log" },
  { key: "?", label: "help" },
  { key: "^Q", label: "quit" },
];

export const BeeApp: React.FC<BeeAppProps> = ({ screens }) => {
  const { exit } = useApp();
  const tui = useTui();
  const [tabIndex, setTabIndex] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const { columns: termCols } = useDimensions();

  const modalOpen = tui.activeModal !== null;
  const count = screens.length;

  const globalActive = !modalOpen && !showHelp && !tui.inputCaptured;

  const globalBindings: KeyBinding[] = [
    { key: "ctrl+q", label: "quit", group: "global", run: () => exit() },
    { key: "?", label: "help", group: "global", run: () => setShowHelp(true) },
    {
      key: "ctrl+l",
      label: "login",
      group: "global",
      when: () => !tui.loggedIn,
      run: () => {
        void tui.openModal<Record<string, string>>({
          id: "login",
          render: (resolve) => (
            <FormModal
              title={`${SYM.bee} Login to CloudBees`}
              fields={[
                { name: "url", label: "Server URL", required: true },
                { name: "username", label: "Username", required: true },
                { name: "token", label: "API Token", required: true, password: true },
              ]}
              onResult={resolve}
            />
          ),
        }).then(async (vals) => {
          if (!vals) return;
          try {
            await tui.login(vals.url!, vals.username!, vals.token!);
            tui.notify(`${SYM.ok} Logged in as ${vals.username}`, "success");
          } catch (err) {
            tui.notify(err instanceof Error ? err.message : String(err), "error");
          }
        });
      },
    },
    {
      key: "P",
      label: "profile",
      group: "global",
      when: () => tui.loggedIn,
      run: () => {
        const profiles = listProfiles(tui.dbPath);
        if (profiles.length <= 1) {
          tui.notify("Only one profile", "info");
          return;
        }
        const names = profiles.map((p) => p.name);
        void tui.openModal<Record<string, string>>({
          id: "switch-profile",
          render: (resolve) => (
            <FormModal
              title={`${SYM.bee} Switch Profile`}
              fields={[
                { name: "profile", label: "Profile", options: names, initial: tui.profile },
              ]}
              onResult={resolve}
            />
          ),
        }).then((vals) => {
          if (!vals) return;
          const name = vals.profile!;
          if (name === tui.profile) return;
          if (tui.switchProfile(name)) {
            tui.notify(`${SYM.arrow} Switched to ${name}`, "success");
          } else {
            tui.notify(`No session for profile '${name}'`, "error");
          }
        });
      },
    },
    { key: "tab", label: "next", group: "global", hidden: true, run: () => setTabIndex((t) => (t + 1) % count) },
    { key: "shift+tab", label: "prev", group: "global", hidden: true, run: () => setTabIndex((t) => (t - 1 + count) % count) },
    { key: "left", label: "prev", group: "global", hidden: true, run: () => setTabIndex((t) => (t - 1 + count) % count) },
    { key: "right", label: "next", group: "global", hidden: true, run: () => setTabIndex((t) => (t + 1) % count) },
    { key: "L", label: "log", group: "global", run: () => setShowLog((v) => !v) },
    // Number shortcuts 1–9 for tabs
    ...screens.slice(0, 9).map((_, i) => ({
      key: String(i + 1),
      label: screens[i]!.title,
      group: "global" as const,
      hidden: true,
      run: () => setTabIndex(i),
    })),
  ];

  const helpBindings: KeyBinding[] = [
    { key: "?", label: "close", run: () => setShowHelp(false) },
    { key: "Esc", label: "close", run: () => setShowHelp(false) },
  ];

  useKeymap(globalBindings, { isActive: globalActive });
  useKeymap(helpBindings, { isActive: showHelp && !modalOpen });

  const active = screens[tabIndex];

  // Build the separator line that spans the full terminal width.
  const sepLine = SYM.sep.repeat(Math.max(0, termCols - 2));

  return (
    <Box flexDirection="column" paddingX={1} width="100%">
      {/* ── Tab bar ── */}
      <Box justifyContent="space-between">
        <Box>
          <Text color={THEME.active} bold>{SYM.bee}  </Text>
          {screens.map((s, i) => {
            const on = i === tabIndex;
            const num = i < 9 ? String(i + 1) : "0";
            return (
              <React.Fragment key={s.id}>
                {i > 0 && <Text color={THEME.subtle}>  </Text>}
                <Text color={on ? THEME.active : THEME.dim} bold={on}>
                  <Text color={on ? THEME.subtle : THEME.subtle}>{num}:</Text>
                  {s.icon ? `${s.icon} ` : ""}{s.title}
                  {on ? <Text color={THEME.active}> ▾</Text> : ""}
                </Text>
              </React.Fragment>
            );
          })}
        </Box>
        {/* User / controller info — right side */}
        <Text color={THEME.dim}>
          {tui.loggedIn
            ? `${tui.username}${tui.activeController ? `@${tui.activeController}` : ""}`
            : "not logged in"}
        </Text>
      </Box>

      {/* ── Separator ── */}
      <Text color={THEME.subtle}>{sepLine}</Text>

      {/* ── Body ── */}
      <Box flexDirection="column" marginTop={0} minHeight={14}>
        {modalOpen ? (
          tui.activeModal!.node
        ) : showHelp ? (
          <HelpScreen screens={screens} />
        ) : active ? (
          <active.Component ctx={tui} active={!modalOpen && !showHelp} />
        ) : (
          <Text color={THEME.dim}>No screens registered.</Text>
        )}
      </Box>

      {/* ── Toast ── */}
      <Toast message={tui.toast} />

      {/* ── Command Log (toggled with L, default off) ── */}
      {showLog && <CommandLog entries={tui.commandLog} />}

      {/* ── Footer status bar ── */}
      <Box
        borderStyle="single"
        borderColor={THEME.subtle}
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
      >
        <StatusBar
          hints={modalOpen || tui.inputCaptured ? [] : tui.activeKeyHints}
          globalHints={modalOpen || tui.inputCaptured ? [] : GLOBAL_HINTS}
        />
      </Box>
    </Box>
  );
};

const HelpScreen: React.FC<{ screens: TuiScreen[] }> = ({ screens }) => (
  <Box flexDirection="column" borderStyle="round" borderColor={THEME.keyhint} paddingX={2} paddingY={1}>
    <Text color={THEME.keyhint} bold>{SYM.bee} bee — Help</Text>
    <Box marginTop={1} flexDirection="column">
      <Text color={THEME.active} bold>Global</Text>
      <Text color={THEME.dim}>  Tab / ← →   switch tabs</Text>
      <Text color={THEME.dim}>  1–{screens.length}         jump to tab</Text>
      <Text color={THEME.dim}>  L            toggle command log</Text>
      <Text color={THEME.dim}>  ?            this help</Text>
      <Text color={THEME.dim}>  Ctrl+q       quit</Text>
      <Text color={THEME.dim}> </Text>
      <Text color={THEME.active} bold>Tables</Text>
      <Text color={THEME.dim}>  ↑/↓ / j/k   navigate rows</Text>
      <Text color={THEME.dim}>  Ctrl+f/b     page down/up</Text>
      <Text color={THEME.dim}>  Enter        open action menu</Text>
      <Text color={THEME.dim}>  /            search/filter</Text>
      <Text color={THEME.dim}> </Text>
      <Text color={THEME.active} bold>Tabs</Text>
      {screens.map((s, i) => (
        <Text key={s.id} color={THEME.dim}>
          {"  "}{i + 1}  {s.icon ? `${s.icon} ` : ""}{s.title}
        </Text>
      ))}
    </Box>
    <Box marginTop={1}>
      <Text color={THEME.dim}>? / Esc to close</Text>
    </Box>
  </Box>
);
