/**
 * GrantListOverlay — a read + manage overlay for Folders Plus controlled-agent
 * grants, used from two symmetric vantage points:
 *
 *   • Node tab  → "Approve Folder":   folders this agent is allowed to run.
 *   • Job (FD)  → "Controlled Agents": agents allowed to run this folder.
 *
 * The parent owns data fetching and the add/revoke actions; this component is
 * pure presentation + key handling (↑↓ move · a add · d revoke · r refresh ·
 * Esc close).
 */

import { useState, useRef } from "react";
import { Box, Text, useInput } from "ink";
import type { FC } from "react";
import { THEME } from "../theme";
import { SYM, borderStyle } from "../symbols";
import { useOnClick, getBoundingClientRect } from "@ink-tools/ink-mouse";

const GrantListClickHandler: FC<{
  listRef: React.RefObject<any>;
  count: number;
  onSelect: (i: number) => void;
}> = ({ listRef, count, onSelect }) => {
  useOnClick(listRef as any, (event) => {
    const rect = getBoundingClientRect(listRef.current);
    if (!rect) return;
    const idx = event.y - rect.top - 1; // -1 for header row
    if (idx >= 0 && idx < count) onSelect(idx);
  });
  return null;
};

export interface GrantItem {
  /** Display label — folder name (node side) or agent name (folder side). */
  label: string;
  /** Opaque id used to revoke this grant (grantId or tokenId). */
  id: string;
  /** True when the grant exists but has no folder/agent assigned yet (pending handshake). */
  pending?: boolean;
}

export interface GrantListOverlayProps {
  title: string;
  /** One-line context under the title (e.g. the agent or folder name). */
  subtitle?: string;
  /** Column header for the item list ("Folder" or "Agent"). */
  itemHeader: string;
  /** null = still loading; [] = loaded but empty. */
  items: GrantItem[] | null;
  emptyText: string;
  /** Label for the add action shown in the footer (e.g. "approve folder"). */
  addHint: string;
  onAdd: () => void;
  onRevoke: (item: GrantItem) => void;
  onRefresh: () => void;
  onClose: () => void;
  /** Gate input — false while a child modal (add/confirm) covers this overlay. */
  isActive?: boolean;
}

// Separate hook component so useInput is fully unmounted (not just disabled)
// when a modal is open, preventing Ink from firing events to this handler.
const GrantListInput: FC<{
  count: number;
  items: GrantItem[] | null;
  cursor: number;
  setCursor: (fn: (c: number) => number) => void;
  onAdd: () => void;
  onRevoke: (item: GrantItem) => void;
  onRefresh: () => void;
  onClose: () => void;
}> = ({ count, items, cursor, setCursor, onAdd, onRevoke, onRefresh, onClose }) => {
  useInput((input, key) => {
    if (key.escape) { onClose(); return; }
    if (key.upArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor((c) => Math.min(count - 1, c + 1)); return; }
    if (input === "a") { onAdd(); return; }
    if (input === "r") { onRefresh(); return; }
    if (input === "d") {
      // Revoke works for pending grants too: an unassigned grant still has a
      // valid id, and a stuck/pending grant (failed handshake) is exactly what
      // a user needs to clean up.
      const item = items?.[cursor];
      if (item) onRevoke(item);
      return;
    }
  });
  return null;
};

export const GrantListOverlay: FC<GrantListOverlayProps> = ({
  title,
  subtitle,
  itemHeader,
  items,
  emptyText,
  addHint,
  onAdd,
  onRevoke,
  onRefresh,
  onClose,
  isActive = true,
}) => {
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<typeof Box>(null);
  const isTty = Boolean(process.stdout.isTTY);
  const count = items?.length ?? 0;

  return (
    <Box flexDirection="column" borderStyle={borderStyle()} borderColor={THEME.keyhint} paddingX={2} paddingY={1} marginX={2}>
      {isActive && (
        <GrantListInput
          count={count}
          items={items}
          cursor={cursor}
          setCursor={setCursor}
          onAdd={onAdd}
          onRevoke={onRevoke}
          onRefresh={onRefresh}
          onClose={onClose}
        />
      )}
      <Text color={THEME.keyhint} bold>{title}</Text>
      {subtitle ? <Text color={THEME.dim}>{subtitle}</Text> : null}

      <Box flexDirection="column" marginTop={1}>
        {isTty && (
          <GrantListClickHandler
            listRef={listRef as any}
            count={count}
            onSelect={(i) => setCursor(i)}
          />
        )}
        {items === null ? (
          <Text color={THEME.dim}>Loading…</Text>
        ) : count === 0 ? (
          <Text color={THEME.dim}>{emptyText}</Text>
        ) : (
          <>
            <Text color={THEME.subtle}>{"   "}{itemHeader}</Text>
            <Box ref={isTty ? listRef as any : undefined} flexDirection="column">
            {items.map((item, i) => {
              const on = i === cursor;
              const label = item.pending ? "(unassigned — pending)" : item.label;
              const color = item.pending ? THEME.dim : (on ? THEME.normal : THEME.dim);
              return (
                <Box key={item.id}>
                  <Text color={on ? THEME.active : THEME.dim}>{on ? SYM.selected : " "}{" "}</Text>
                  <Text color={color} bold={on && !item.pending}>{label}</Text>
                </Box>
              );
            })}
            </Box>
          </>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={THEME.dim}>↑↓ move  ·  a {addHint}  ·  d revoke  ·  r refresh  ·  Esc back</Text>
      </Box>
    </Box>
  );
};
