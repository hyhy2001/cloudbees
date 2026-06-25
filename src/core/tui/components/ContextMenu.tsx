/**
 * ContextMenu — a numbered action menu overlay.
 *
 * Keys inside the menu:
 *   1–9, 0   fire action at that index directly
 *   ↑ / ↓    move highlight
 *   Enter    run highlighted action
 *   Esc      close without action
 */

import { useCallback, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { FC } from "react";
import { Modal } from "./Modal";
import { THEME } from "../theme";
import { SYM } from "../symbols";

export interface ContextMenuAction {
  label: string;
  /**
   * Return `false` to keep the menu open (e.g. user cancelled a sub-modal).
   * Return void / undefined to close the menu after the action completes.
   * May be async.
   */
  run: () => void | false | Promise<void | false>;
  /**
   * When false, the action is not shown in the menu at all.
   * Evaluated at render time.
   */
  when?: () => boolean;
  /** Icon symbol to show before the label. */
  icon?: string;
  /** When true, label is colored danger (destructive action). */
  danger?: boolean;
}

export interface ContextMenuProps {
  title: string;
  actions: ContextMenuAction[];
  onClose: () => void;
  /**
   * Gate keyboard input. Defaults to true. Set false when a modal opened from
   * a menu action covers this menu — the menu stays mounted (so its state
   * survives) but must not also consume Esc, or closing the modal would close
   * the menu too and drop the user back to the bare list.
   */
  isActive?: boolean;
}

export const ContextMenu: FC<ContextMenuProps> = ({ title, actions, onClose, isActive = true }) => {
  const visible = actions.filter((a) => !a.when || a.when());
  const [cursor, setCursor] = useState(0);
  const menuRef = useRef<typeof Box>(null);

  const run = useCallback(
    (idx: number) => {
      const action = visible[idx];
      if (!action) return;
      const result = action.run();
      if (result instanceof Promise) {
        void result.then((ret) => { if (ret !== false) onClose(); });
      } else {
        if (result !== false) onClose();
      }
    },
    [visible, onClose],
  );

  useInput((input, key) => {
    if (key.escape) { onClose(); return; }
    if (key.upArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor((c) => Math.min(visible.length - 1, c + 1)); return; }
    if (key.return) { run(cursor); return; }
    if (input >= "1" && input <= "9") { run(parseInt(input, 10) - 1); return; }
    if (input === "0") { run(9); return; }
  }, { isActive });

  // Truncate long titles gracefully
  const maxTitleLen = 32;
  const displayTitle = title.length > maxTitleLen
    ? title.slice(0, maxTitleLen - 1) + "…"
    : title;

  return (
    <Modal title={displayTitle}>
      {visible.length === 0 ? (
        <Text color={THEME.dim}>(no actions available)</Text>
      ) : (
        <Box ref={menuRef as any} flexDirection="column">
        {visible.map((action, i) => {
          const on = i === cursor;
          const numStr = i < 9 ? String(i + 1) : "0";
          const labelColor = action.danger
            ? (on ? THEME.danger : THEME.error)
            : (on ? THEME.normal : THEME.dim);
          const icon = action.icon ?? SYM.arrow;
          return (
            <Box key={action.label}>
              {/* Cursor indicator */}
              <Text color={on ? THEME.active : THEME.dim}>
                {on ? SYM.selected : " "}{" "}
              </Text>
              {/* Number shortcut */}
              <Text color={on ? THEME.keyhint : THEME.subtle}>{numStr}</Text>
              {/* Icon */}
              <Text color={labelColor}>{"  "}{icon}{"  "}</Text>
              {/* Label */}
              <Text color={labelColor} bold={on && !action.danger}>
                {action.label}
              </Text>
            </Box>
          );
        })}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={THEME.dim}>↑↓ move  ·  1–9 pick  ·  Enter run  ·  Esc back</Text>
      </Box>
    </Modal>
  );
};
