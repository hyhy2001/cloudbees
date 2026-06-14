/**
 * EmailBuilder — a full-screen overlay for editing a job's email-ext config.
 * Rendered in place of a screen (like ScheduleBuilder / ParamListEditor).
 *
 *   ↑/↓ move rows · ←/→ toggle boolean rows · Enter edit text row
 *   Enter on the last row saves · Esc cancel
 *
 * Returns EmailSpec on confirm, or null on cancel.
 */

import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { FC } from "react";
import { Modal } from "./Modal";
import { THEME } from "../theme";
import { SYM } from "../symbols";

export interface EmailSpec {
  enabled: boolean;
  email: string;
  emailCond: string;
  emailKeywords: string;
  emailRegex: string;
}

export interface EmailBuilderProps {
  initial: EmailSpec;
  onResult: (spec: EmailSpec | null) => void;
  setInputCaptured: (captured: boolean) => void;
  /** False when email-ext plugin is not detected on the server. Disables keywords/regex rows. */
  groovyAvailable?: boolean;
}

type RowKind = "enabled" | "email" | "cond" | "keywords" | "regex";

const COND_OPTIONS = ["failed", "success", "always", "custom"] as const;
type Cond = (typeof COND_OPTIONS)[number];

const COND_LABEL: Record<Cond, string> = {
  failed: "On failure",
  success: "On success",
  always: "Always",
  custom: "Custom (keyword/regex)",
};

function activeRows(spec: EmailSpec): RowKind[] {
  if (!spec.enabled) return ["enabled"];
  if (spec.emailCond === "custom") return ["enabled", "email", "cond", "keywords", "regex"];
  return ["enabled", "email", "cond"];
}

const ROW_LABEL: Record<RowKind, string> = {
  enabled: "Enable email",
  email: "Recipient(s)",
  cond: "Send condition",
  keywords: "Keywords",
  regex: "Regex filter",
};

const ROW_HINT: Record<RowKind, string> = {
  enabled: "toggle with ←/→",
  email: "Enter to edit",
  cond: "←/→ cycle · choose Custom to filter by keyword/regex",
  keywords: "Enter to edit · comma-separated",
  regex: "Enter to edit · Java regex",
};

export const EmailBuilder: FC<EmailBuilderProps> = ({
  initial,
  onResult,
  setInputCaptured,
  groovyAvailable = true,
}) => {
  const [spec, setSpec] = useState<EmailSpec>(initial);
  const [cursor, setCursor] = useState(0);
  // Which text row (email/keywords/regex) is being edited inline.
  const [editing, setEditing] = useState<RowKind | null>(null);
  // The live text value while editing.
  const [editBuf, setEditBuf] = useState("");
  const inputRef = useRef(false);

  useEffect(() => {
    setInputCaptured(true);
    return () => setInputCaptured(false);
  }, [setInputCaptured]);

  const rows = activeRows(spec);
  const row = rows[Math.min(cursor, rows.length - 1)]!;

  const cycleCond = (dir: number) => {
    setSpec((s) => {
      const idx = COND_OPTIONS.indexOf(s.emailCond as Cond);
      const next = COND_OPTIONS[((idx + dir + COND_OPTIONS.length) % COND_OPTIONS.length)]!;
      return { ...s, emailCond: next };
    });
  };

  const startEdit = (kind: RowKind) => {
    const val = kind === "email" ? spec.email
      : kind === "keywords" ? spec.emailKeywords
      : spec.emailRegex;
    setEditing(kind);
    setEditBuf(val);
    inputRef.current = true;
  };

  const commitEdit = () => {
    if (editing === "email") setSpec((s) => ({ ...s, email: editBuf }));
    else if (editing === "keywords") setSpec((s) => ({ ...s, emailKeywords: editBuf }));
    else if (editing === "regex") setSpec((s) => ({ ...s, emailRegex: editBuf }));
    setEditing(null);
    inputRef.current = false;
  };

  useInput((input, key) => {
    // --- text editing mode ---
    if (editing !== null) {
      if (key.return) { commitEdit(); return; }
      if (key.escape) { setEditing(null); inputRef.current = false; return; }
      if (key.backspace || key.delete) { setEditBuf((b) => b.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) { setEditBuf((b) => b + input); return; }
      return;
    }

    // --- nav mode ---
    if (key.escape) { onResult(null); return; }
    if (key.return) {
      if (row === "email") {
        startEdit(row);
        return;
      }
      if ((row === "keywords" || row === "regex") && groovyAvailable) {
        startEdit(row);
        return;
      }
      // Enter on enabled row toggles; Enter on cond row saves.
      if (row === "enabled") {
        setSpec((s) => ({ ...s, enabled: !s.enabled }));
        return;
      }
      // Save
      onResult(spec);
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(rows.length - 1, c + 1));
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      const dir = key.rightArrow ? 1 : -1;
      if (row === "enabled") {
        setSpec((s) => ({ ...s, enabled: !s.enabled }));
        if (spec.enabled) setCursor(0); // collapse back to top when disabling
      } else if (row === "cond") {
        cycleCond(dir);
      }
    }
  });

  const renderRow = (kind: RowKind, idx: number) => {
    const on = idx === Math.min(cursor, rows.length - 1);
    const label = ROW_LABEL[kind];
    let value = "";
    let isEditing = false;

    if (kind === "enabled") {
      value = spec.enabled ? "[X] enabled" : "[ ] disabled";
    } else if (kind === "email") {
      isEditing = editing === "email";
      value = isEditing ? `${editBuf}_` : (spec.email || "(none)");
    } else if (kind === "cond") {
      value = COND_LABEL[spec.emailCond as Cond] ?? spec.emailCond;
    } else if (kind === "keywords") {
      isEditing = editing === "keywords";
      value = !groovyAvailable
        ? "(unavailable — email-ext plugin not installed)"
        : isEditing ? `${editBuf}_` : (spec.emailKeywords || "(none)");
    } else if (kind === "regex") {
      isEditing = editing === "regex";
      value = !groovyAvailable
        ? "(unavailable — email-ext plugin not installed)"
        : isEditing ? `${editBuf}_` : (spec.emailRegex || "(none)");
    }

    const unavailable = !groovyAvailable && (kind === "keywords" || kind === "regex");
    const cycler = kind === "cond" || kind === "enabled";
    const rowHint = unavailable
      ? "requires email-ext plugin on the CloudBees server"
      : ROW_HINT[kind];

    return (
      <Box key={kind} flexDirection="column">
        <Box>
          <Text color={on ? THEME.active : THEME.dim}>
            {on ? SYM.arrow : " "} {label.padEnd(16)}
          </Text>
          <Text color={unavailable ? THEME.dim : isEditing ? THEME.normal : (on ? THEME.normal : THEME.dim)}>
            {cycler && on ? `${SYM.arrow} ` : ""}
            {value}
            {cycler && on ? ` ${SYM.arrow}` : ""}
          </Text>
        </Box>
        {on && (
          <Text color={unavailable ? THEME.warning : THEME.dim}>
            {"                   "}{rowHint}
          </Text>
        )}
      </Box>
    );
  };

  const hint = editing !== null
    ? "Enter save · Esc cancel edit"
    : "↑↓ move · ←→ toggle · Enter edit/save · Esc cancel";

  return (
    <Modal title={`${SYM.gear} Email Settings`}>
      {rows.map((kind, idx) => renderRow(kind, idx))}
      <Box marginTop={1}>
        <Text color={THEME.dim}>{hint}</Text>
      </Box>
    </Modal>
  );
};
