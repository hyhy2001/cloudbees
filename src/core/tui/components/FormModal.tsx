/**
 * FormModal — a sequential multi-field text form rendered as a modal.
 * Port of the create-job / create-node / create-credential / login modals.
 *
 * ↑/↓ / Tab navigate between fields. Enter submits the form from any
 * field. Esc cancels. A field marked `password` renders its value masked.
 * A field with `options` cycles with ←/→; if `searchable` is also set,
 * Enter/typing opens an inline filtered dropdown (Enter there selects, not
 * submits — Esc closes dropdown back to normal nav).
 * Free-text fields support Home/End to jump cursor to start/end.
 * Path fields show a vertical candidate list on Tab; ↑/↓ navigate and fill.
 * Fields with `visible` returning false are skipped in nav and not rendered.
 *
 * Hints are displayed at a fixed column (col 3) so they form a clean right
 * margin regardless of value length.
 */

import React, { useState, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { Modal } from "./Modal";
import { THEME } from "../theme";
import { SYM } from "../symbols";
import { TextBox } from "./TextBox";
import { completePath } from "../data/path-complete";
import { resolve } from "node:path";
import { useDimensions } from "../data/use-dimensions";
import { useOnClick, useBoundingClientRect } from "@ink-tools/ink-mouse";

// Only rendered inside <MouseProvider> (when process.stdout.isTTY is true), so
// the mouse hooks always have a provider context and never throw.
const FormFieldClickHandler: React.FC<{
  formRef: React.RefObject<any>;
  visibleFieldsLength: number;
  onFieldClick: (index: number) => void;
}> = ({ formRef, visibleFieldsLength, onFieldClick }) => {
  // Re-measure on terminal resize so field click targeting stays accurate.
  const { columns, rows } = useDimensions();
  const rect = useBoundingClientRect(formRef as any, [columns, rows]);
  useOnClick(formRef as any, (event) => {
    if (!rect) return;
    const rowOffset = event.y - rect.top - 1;
    if (rowOffset >= 0 && rowOffset < visibleFieldsLength) {
      onFieldClick(rowOffset);
    }
  });
  return null;
};

export interface FormField {
  name: string;
  label: string;
  placeholder?: string;
  password?: boolean;
  options?: string[];
  /** When true, Enter/typing opens a filtered inline dropdown instead of ←/→ cycling. */
  searchable?: boolean;
  initial?: string;
  required?: boolean;
  hint?: string;
  path?: boolean;
  /** When provided, field is hidden (not rendered, not navigable) if it returns false. */
  visible?: (values: Record<string, string>) => boolean;
}

export interface FormModalProps {
  title: string;
  fields: FormField[];
  onResult: (values: Record<string, string> | null) => void;
}

export const FormModal: React.FC<FormModalProps> = ({ title, fields, onResult }) => {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of fields) {
      init[f.name] = f.initial ?? (f.options ? (f.options[0] ?? "") : "");
    }
    return init;
  });
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState("");
  const [candidates, setCandidates] = useState<string[]>([]);
  // Cursor position within the current text field (in characters from start).
  const [textPos, setTextPos] = useState(0);
  // Cursor within the path candidate list (↑/↓ fills candidate into field).
  const [candidateCursor, setCandidateCursor] = useState(0);
  // Searchable dropdown state for options fields with searchable:true.
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownQuery, setDropdownQuery] = useState("");
  const [dropdownCursor, setDropdownCursor] = useState(0);

  // Only fields currently visible participate in navigation.
  const visibleFields = fields.filter((f) => !f.visible || f.visible(values));
  const field = visibleFields[cursor] ?? visibleFields[0];

  const formRef = useRef<typeof Box>(null);
  const isTty = Boolean(process.stdout.isTTY);

  function setFieldValue(name: string, value: string, pos?: number): void {
    setValues((prev) => ({ ...prev, [name]: value }));
    if (pos !== undefined) setTextPos(pos);
    else if (pos === undefined && field?.name === name) {
      // keep pos clamped to new length
      setTextPos((p) => Math.min(p, value.length));
    }
  }

  // Reset textPos when moving to a different field.
  function moveTo(next: number): void {
    setCursor(next);
    const nextField = visibleFields[next];
    if (nextField) {
      const val = values[nextField.name] ?? "";
      setTextPos(val.length); // cursor at end on entry
    }
    setCandidates([]);
    setCandidateCursor(0);
    setDropdownOpen(false);
    setDropdownQuery("");
    setDropdownCursor(0);
  }

  function submit(): void {
    for (const f of visibleFields) {
      if (f.required && !values[f.name]?.trim()) {
        setError(`${f.label} is required`);
        const idx = visibleFields.indexOf(f);
        moveTo(idx);
        return;
      }
    }
    onResult(values);
  }

  useInput((input, key) => {
    if (key.escape) {
      if (dropdownOpen) { setDropdownOpen(false); setDropdownQuery(""); setDropdownCursor(0); return; }
      onResult(null); return;
    }
    if (!field) return;

    // ── Searchable dropdown mode ────────────────────────────────────────────
    if (field.options && field.searchable) {
      const opts = field.options;
      const filtered = opts.filter((o) => o.toLowerCase().includes(dropdownQuery.toLowerCase()));
      const clampedDDCursor = Math.min(dropdownCursor, Math.max(0, filtered.length - 1));

      if (dropdownOpen) {
        if (key.backspace || key.delete) {
          setDropdownQuery((q) => q.slice(0, -1));
          setDropdownCursor(0);
          return;
        }
        if (key.upArrow) {
          setDropdownCursor((c) => Math.max(0, c - 1));
          return;
        }
        if (key.downArrow) {
          setDropdownCursor((c) => Math.min(filtered.length - 1, c + 1));
          return;
        }
        if (key.tab) {
          // Tab closes dropdown and moves field
          setDropdownOpen(false); setDropdownQuery(""); setDropdownCursor(0);
          moveTo(Math.min(cursor + 1, visibleFields.length - 1));
          return;
        }
        if (key.return) {
          const selected = filtered[clampedDDCursor];
          if (selected !== undefined) {
            setFieldValue(field.name, selected);
            setDropdownOpen(false); setDropdownQuery(""); setDropdownCursor(0);
          }
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setDropdownQuery((q) => q + input);
          setDropdownCursor(0);
          return;
        }
        return;
      }

      // Dropdown closed: "/" opens the searchable dropdown. Enter is NOT handled
      // here — it falls through to submit() below (line ~221), so Enter always
      // submits the form regardless of whether a value is already selected.
      if (input === "/") {
        if (opts.length > 0) {
          setDropdownOpen(true);
          setDropdownQuery("");
          setDropdownCursor(0);
        }
        return;
      }
      // ←/→ cycle (unchanged for searchable fields when dropdown is closed)
      const idx = opts.indexOf(values[field.name] ?? opts[0]!);
      if (key.leftArrow) { setFieldValue(field.name, opts[(idx - 1 + opts.length) % opts.length]!); return; }
      if (key.rightArrow) { setFieldValue(field.name, opts[(idx + 1) % opts.length]!); return; }
    }

    // ── Non-searchable options: ←/→ cycle ──────────────────────────────────
    if (field.options && !field.searchable) {
      const opts = field.options;
      const idx = opts.indexOf(values[field.name] ?? opts[0]!);
      if (key.leftArrow) { setFieldValue(field.name, opts[(idx - 1 + opts.length) % opts.length]!); return; }
      if (key.rightArrow) { setFieldValue(field.name, opts[(idx + 1) % opts.length]!); return; }
    }

    // ── Path Tab completion ────────────────────────────────────────────────
    if (key.tab && field.path && !field.options) {
      const { completed, candidates: cands } = completePath(values[field.name] ?? "");
      setFieldValue(field.name, completed, completed.length);
      const sliced = cands.slice(0, 12);
      setCandidates(sliced);
      setCandidateCursor(0);
      return;
    }

    // ── ↑/↓ navigate path candidates (when visible) ────────────────────────
    if (candidates.length > 0 && field.path && !field.options) {
      if (key.upArrow) {
        const next = Math.max(0, candidateCursor - 1);
        setCandidateCursor(next);
        // Fill field: reconstruct dir prefix from current value then append candidate
        const val = values[field.name] ?? "";
        const sep = val.includes("/") ? val.slice(0, val.lastIndexOf("/") + 1) : "";
        const cand = candidates[next] ?? "";
        setFieldValue(field.name, resolve(sep + cand), (sep + cand).length);
        return;
      }
      if (key.downArrow) {
        const next = Math.min(candidates.length - 1, candidateCursor + 1);
        setCandidateCursor(next);
        const val = values[field.name] ?? "";
        const sep = val.includes("/") ? val.slice(0, val.lastIndexOf("/") + 1) : "";
        const cand = candidates[next] ?? "";
        setFieldValue(field.name, resolve(sep + cand), (sep + cand).length);
        return;
      }
    }

    // ── Field navigation ───────────────────────────────────────────────────
    if (key.tab || key.downArrow) {
      moveTo(Math.min(cursor + 1, visibleFields.length - 1));
      return;
    }
    if (key.upArrow) {
      moveTo(Math.max(cursor - 1, 0));
      return;
    }
    if (key.return) {
      submit();
      return;
    }

    // ── Free-text editing ─────────────────────────────────────────────────
    if (!field.options) {
      const val = values[field.name] ?? "";

      // Home / End — jump cursor within text.
      if (key.ctrl && input === "a") { setTextPos(0); return; }   // Ctrl+A = home
      if (key.ctrl && input === "e") { setTextPos(val.length); return; } // Ctrl+E = end
      // Ink passes Home/End as ctrl sequences on most terminals.
      if ((key as { home?: boolean }).home) { setTextPos(0); return; }
      if ((key as { end?: boolean }).end) { setTextPos(val.length); return; }

      if (key.leftArrow && !field.options) { setTextPos((p) => Math.max(0, p - 1)); return; }
      if (key.rightArrow && !field.options) { setTextPos((p) => Math.min(val.length, p + 1)); return; }

      if (key.backspace || key.delete) {
        if (textPos > 0) {
          const next = val.slice(0, textPos - 1) + val.slice(textPos);
          setFieldValue(field.name, next, textPos - 1);
          // Any manual edit clears path candidates
          if (field.path) { setCandidates([]); setCandidateCursor(0); }
        }
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        const next = val.slice(0, textPos) + input + val.slice(textPos);
        setFieldValue(field.name, next, textPos + input.length);
        if (field.path) { setCandidates([]); setCandidateCursor(0); }
      }
    }
  });

  // Compute the hint column dynamically: align to the widest label+value row
  // across all visible fields so hints form a clean vertical column.
  const LABEL_W = 16;
  const hintCol = (() => {
    let max = 0;
    for (const f of visibleFields) {
      const val = values[f.name] ?? "";
      const masked = f.password ? "*".repeat(val.length) : val;
      const disp = masked || (f.placeholder ?? "");
      // "▸ " prefix (2) + label (LABEL_W) + " " (1) + value/arrows
      const valueLen = (f.options && !f.searchable) ? disp.length + 4 : Math.max(disp.length, 1);
      max = Math.max(max, 2 + LABEL_W + 1 + valueLen);
    }
    return max + 2; // 2-space gap before hint
  })();

  return (
    <Modal title={title}>
      {isTty && (
        <FormFieldClickHandler
          formRef={formRef as any}
          visibleFieldsLength={visibleFields.length}
          onFieldClick={(idx) => setCursor(idx)}
        />
      )}
      <Box ref={formRef as any} flexDirection="column">
      {fields.map((f) => {
        const isVisible = !f.visible || f.visible(values);
        if (!isVisible) return null;
        const visIdx = visibleFields.indexOf(f);
        const isActive = visIdx === cursor;
        const raw = values[f.name] ?? "";
        const maskedRaw = f.password ? "*".repeat(raw.length) : raw;
        const display = maskedRaw || (f.placeholder ? f.placeholder : "");
        const isPlaceholder = !maskedRaw && !!f.placeholder;

        // Build display with block cursor for active text fields.
        const cursorPos = isActive && !f.options ? Math.min(textPos, maskedRaw.length) : -1;

        // Compute padding so hint starts at the dynamic hint column.
        // "▸ " (2) + label (LABEL_W) + " " (1) = 19 chars prefix before value.
        const prefixLen = 2 + LABEL_W + 1;
        const valueDisplayLen = (f.options && !f.searchable) ? display.length + 4 : Math.max(display.length, cursorPos >= 0 ? 1 : 0);
        const pad = Math.max(1, hintCol - prefixLen - valueDisplayLen);
        const paddingStr = " ".repeat(pad);

        const before = cursorPos >= 0 ? maskedRaw.slice(0, cursorPos) : "";
        const atCursor = cursorPos >= 0 ? (maskedRaw[cursorPos] ?? " ") : "";
        const after = cursorPos >= 0 ? maskedRaw.slice(cursorPos + 1) : "";

        return (
          <Box key={f.name}>
            <Text color={isActive ? THEME.active : THEME.dim}>
              {isActive ? SYM.arrow : " "} {f.label.padEnd(LABEL_W)}
            </Text>
            {f.options && !f.searchable ? (
              <Text color={THEME.normal}>
                {SYM.arrow} {maskedRaw} {SYM.arrow}
              </Text>
            ) : f.options && f.searchable ? (
              <Text color={isActive ? THEME.normal : THEME.dim}>
                {maskedRaw || "(none)"}
                {isActive ? <Text color={THEME.dim}> /search</Text> : null}
              </Text>
            ) : cursorPos >= 0 ? (
              <Text color={isPlaceholder ? THEME.dim : THEME.normal}>
                {before}<Text inverse>{atCursor}</Text>{after}
              </Text>
            ) : (
              <Text color={isPlaceholder ? THEME.dim : THEME.normal}>
                {display}
              </Text>
            )}
            {f.hint ? (
              <Text color={THEME.dim}>{paddingStr}{f.hint}</Text>
            ) : null}
          </Box>
        );
      })}
      </Box>
      {candidates.length > 0 && field?.path ? (
        <Box flexDirection="column" marginTop={1}>
          {candidates.slice(0, 8).map((c, i) => {
            const isLastVisible = i === Math.min(candidates.length, 8) - 1;
            const prefix = isLastVisible ? "└─" : "├─";
            return (
              <Text key={c} color={i === candidateCursor ? THEME.active : THEME.dim}>
                {prefix} {c}
              </Text>
            );
          })}
          {candidates.length > 8 && (
            <Text color={THEME.dim}>   …{candidates.length - 8} more</Text>
          )}
        </Box>
      ) : null}
      {dropdownOpen && field?.options && field.searchable ? (
        <Box flexDirection="column" borderStyle="round" marginTop={1} paddingX={1}>
          <Text color={THEME.dim}>{"> "}{dropdownQuery}<Text inverse>{" "}</Text></Text>
          {(() => {
            const filtered = field.options.filter((o) =>
              o.toLowerCase().includes(dropdownQuery.toLowerCase())
            );
            if (filtered.length === 0) {
              return <Text color={THEME.dim}>(no matches)</Text>;
            }
            const visible = filtered.slice(0, 8);
            return (
              <>
                {visible.map((opt, i) => (
                  <Text key={opt} color={i === Math.min(dropdownCursor, filtered.length - 1) ? THEME.active : THEME.normal}>
                    {i === Math.min(dropdownCursor, filtered.length - 1) ? SYM.arrow : " "} {opt}
                  </Text>
                ))}
                {filtered.length > 8 && (
                  <Text color={THEME.dim}>  …{filtered.length - 8} more</Text>
                )}
              </>
            );
          })()}
        </Box>
      ) : null}
      {error ? (
        <Box marginTop={1}>
          <Text color={THEME.error}>{SYM.fail} {error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={THEME.dim}>
          {dropdownOpen
            ? "type filter · ↑↓ move · Enter select · Esc close"
            : candidates.length > 0 && field?.path
            ? "↑↓ select candidate · Tab complete again · Enter submit · Esc cancel"
            : field?.path
            ? "Tab complete · ↑↓ move · Enter submit"
            : field?.options && field.searchable
            ? "Enter/type to search · ←→ cycle · ↑↓ move · Enter submit"
            : "↑↓/Tab move · Enter submit"}{" "}
          {dropdownOpen ? "" : `· ←→${field?.options ? " cycle" : " cursor"} · Home/End · Esc cancel`}
        </Text>
      </Box>
    </Modal>
  );
};
