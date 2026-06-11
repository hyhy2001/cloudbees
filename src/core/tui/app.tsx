/**
 * <BeeApp> — the TUI shell.
 *
 * Owns: the tab bar (built from plugin screens), global key handling
 * (q quit, 1-N jump, Tab/Shift+Tab + ←/→ cycle, ? help), and the layout that
 * stacks header / active screen / toast / status bar. When a modal is open it
 * renders the modal *instead of* the active screen and suspends the screen's
 * own input via `active={false}`.
 */

import React, { useState } from "react";
import { Box, Text, useApp } from "ink";
import type { TuiScreen } from "../../registry/types";
import { useTui } from "./context";
import { SYM, borderStyle } from "./symbols";
import { THEME } from "./theme";
import { Toast } from "./components/Toast";
import { StatusBar } from "./components/StatusBar";
import { useKeymap, type KeyBinding } from "./keymap";

export interface BeeAppProps {
  screens: TuiScreen[];
}

const GLOBAL_HINTS = [
  { key: "1-9", label: "tab" },
  { key: "Tab", label: "next" },
  { key: "?", label: "help" },
  { key: "q", label: "quit" },
];

export const BeeApp: React.FC<BeeAppProps> = ({ screens }) => {
  const { exit } = useApp();
  const tui = useTui();
  const [tabIndex, setTabIndex] = useState(0);
  const [showHelp, setShowHelp] = useState(false);

  const modalOpen = tui.activeModal !== null;
  const count = screens.length;

  // Global keys. Suspended while a modal, the help screen, or a non-modal
  // overlay (e.g. the log viewer, via ctx.inputCaptured) owns input.
  const globalActive = !modalOpen && !showHelp && !tui.inputCaptured;

  const globalBindings: KeyBinding[] = [
    { key: "q", label: "quit", group: "global", run: () => exit() },
    { key: "?", label: "help", group: "global", run: () => setShowHelp(true) },
    { key: "tab", label: "next", group: "global", hidden: true, run: () => setTabIndex((t) => (t + 1) % count) },
    { key: "shift+tab", label: "prev", group: "global", hidden: true, run: () => setTabIndex((t) => (t - 1 + count) % count) },
    { key: "left", label: "prev", group: "global", hidden: true, run: () => setTabIndex((t) => (t - 1 + count) % count) },
    { key: "right", label: "next", group: "global", hidden: true, run: () => setTabIndex((t) => (t + 1) % count) },
    // Number keys 1..9 jump to a tab.
    ...Array.from({ length: Math.min(count, 9) }, (_, i): KeyBinding => ({
      key: String(i + 1),
      label: `tab${i + 1}`,
      group: "global",
      hidden: true,
      run: () => setTabIndex(i),
    })),
  ];

  // While help is open, only its dismiss keys are live.
  const helpBindings: KeyBinding[] = [
    { key: "?", label: "close", run: () => setShowHelp(false) },
    { key: "Esc", label: "close", run: () => setShowHelp(false) },
    { key: "q", label: "close", run: () => setShowHelp(false) },
  ];

  useKeymap(globalBindings, { isActive: globalActive });
  useKeymap(helpBindings, { isActive: showHelp && !modalOpen });

  const active = screens[tabIndex];

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header / tab bar */}
      <Box>
        <Text color={THEME.active} bold>
          {SYM.bee} bee{"  "}
        </Text>
        {screens.map((s, i) => {
          const on = i === tabIndex;
          return (
            <Text
              key={s.id}
              color={on ? THEME.selectedFg : THEME.dim}
              backgroundColor={on ? THEME.headerBg : undefined}
              bold={on}
            >
              {" "}
              {i + 1}:{s.icon ? `${s.icon} ` : ""}
              {s.title}{" "}
            </Text>
          );
        })}
        <Text color={THEME.dim}>
          {"   "}
          {tui.loggedIn ? `${tui.username}${tui.activeController ? ` ${SYM.arrow} ${tui.activeController}` : ""}` : "not logged in"}
        </Text>
      </Box>

      {/* Body: modal takes over, else the active screen */}
      <Box flexDirection="column" marginTop={1} minHeight={14}>
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

      {/* Toast */}
      <Box marginTop={1}>
        <Toast message={tui.toast} />
      </Box>

      {/* Footer */}
      <Box
        borderStyle={borderStyle()}
        borderColor={THEME.dim}
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
      >
        <StatusBar hints={[...tui.activeKeyHints, ...GLOBAL_HINTS]} />
      </Box>
    </Box>
  );
};

const HelpScreen: React.FC<{ screens: TuiScreen[] }> = ({ screens }) => (
  <Box flexDirection="column" borderStyle={borderStyle()} borderColor={THEME.keyhint} paddingX={2} paddingY={1}>
    <Text color={THEME.keyhint} bold>
      {SYM.bee} bee — Help
    </Text>
    <Box marginTop={1} flexDirection="column">
      <Text color={THEME.normal} bold>
        Global
      </Text>
      <Text color={THEME.dim}> 1-9 jump tab · Tab/Shift+Tab cycle · ←/→ cycle · ? help · q quit</Text>
      <Text color={THEME.normal} bold>
        {" "}
      </Text>
      <Text color={THEME.normal} bold>
        Navigation (in tables)
      </Text>
      <Text color={THEME.dim}> j/↓ down · k/↑ up · g top · G bottom · Ctrl+f/b page · Enter detail</Text>
      <Text color={THEME.normal} bold>
        {" "}
      </Text>
      <Text color={THEME.normal} bold>
        Tabs
      </Text>
      {screens.map((s) => (
        <Text key={s.id} color={THEME.dim}>
          {" "}
          {s.title}
        </Text>
      ))}
    </Box>
    <Box marginTop={1}>
      <Text color={THEME.dim}>Press ? or Esc to close</Text>
    </Box>
  </Box>
);
