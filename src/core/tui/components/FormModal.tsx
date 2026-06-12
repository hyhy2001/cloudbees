/**
 * FormModal — a sequential multi-field text form rendered as a modal.
 * Port of the create-job / create-node / create-credential / login modals.
 *
 * Fields are filled top to bottom. Tab / Enter moves to the next field;
 * on the last field, Enter submits. Esc cancels. A field marked `password`
 * renders its value masked. A field with `options` cycles with ←/→.
 * Free-text fields support Home/End to jump cursor to start/end.
 * Fields with `visible` returning false are skipped in nav and not rendered.
 *
 * Hints are displayed at a fixed column (col 3) so they form a clean right
 * margin regardless of value length.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Modal } from "./Modal";
import { THEME } from "../theme";
import { SYM } from "../symbols";
import { completePath } from "../data/path-complete";

export interface FormField {
  name: string;
  label: string;
  placeholder?: string;
  password?: boolean;
  options?: string[];
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

/** Column at which hints start (relative to label+value area). */
const HINT_COL = 42;

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

  // Only fields currently visible participate in navigation.
  const visibleFields = fields.filter((f) => !f.visible || f.visible(values));
  const field = visibleFields[cursor] ?? visibleFields[0];

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
    if (key.escape) { onResult(null); return; }
    if (!field) return;

    if (field.options) {
      const opts = field.options;
      const idx = opts.indexOf(values[field.name] ?? opts[0]!);
      if (key.leftArrow) { setFieldValue(field.name, opts[(idx - 1 + opts.length) % opts.length]!); return; }
      if (key.rightArrow) { setFieldValue(field.name, opts[(idx + 1) % opts.length]!); return; }
    }

    if (key.tab && field.path && !field.options) {
      const { completed, candidates: cands } = completePath(values[field.name] ?? "");
      setFieldValue(field.name, completed, completed.length);
      setCandidates(cands.slice(0, 12));
      return;
    }

    if (key.tab || key.downArrow) {
      moveTo(Math.min(cursor + 1, visibleFields.length - 1));
      return;
    }
    if (key.upArrow) {
      moveTo(Math.max(cursor - 1, 0));
      return;
    }
    if (key.return) {
      if (cursor < visibleFields.length - 1) { moveTo(cursor + 1); }
      else { submit(); }
      return;
    }

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
        }
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        const next = val.slice(0, textPos) + input + val.slice(textPos);
        setFieldValue(field.name, next, textPos + input.length);
      }
    }
  });

  // The hint column: pad the label+value area to HINT_COL characters.
  // label.padEnd(16) + " " + value area = roughly 17+value chars; clamp to avoid wrapping.
  const LABEL_W = 16;

  return (
    <Modal title={title}>
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

        // Compute padding so hint starts at fixed column (HINT_COL).
        // Use display length (not maskedRaw) so placeholder text is counted too.
        // Options row adds "← " prefix and " →" suffix (+4).
        const labelPart = ` ${f.label.padEnd(LABEL_W)} `;
        const valueDisplayLen = f.options ? display.length + 4 : Math.max(display.length, cursorPos >= 0 ? 1 : 0);
        const pad = Math.max(1, HINT_COL - labelPart.length - valueDisplayLen);
        const paddingStr = " ".repeat(pad);

        const before = cursorPos >= 0 ? maskedRaw.slice(0, cursorPos) : "";
        const atCursor = cursorPos >= 0 ? (maskedRaw[cursorPos] ?? " ") : "";
        const after = cursorPos >= 0 ? maskedRaw.slice(cursorPos + 1) : "";

        return (
          <Box key={f.name}>
            <Text color={isActive ? THEME.active : THEME.dim}>
              {isActive ? SYM.arrow : " "} {f.label.padEnd(LABEL_W)}
            </Text>
            {f.options ? (
              <Text color={THEME.normal}>
                {SYM.arrow} {maskedRaw} {SYM.arrow}
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
      {candidates.length > 0 && field?.path ? (
        <Box marginTop={1}>
          <Text color={THEME.dim} wrap="truncate-end">
            {candidates.join("  ")}
          </Text>
        </Box>
      ) : null}
      {error ? (
        <Box marginTop={1}>
          <Text color={THEME.error}>{SYM.fail} {error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={THEME.dim}>
          {field?.path ? "Tab complete · ↑↓ move" : "↑↓/Tab move"} · ←→{field?.options ? " cycle" : " cursor"} · Home/End · Enter next/submit · Esc cancel
        </Text>
      </Box>
    </Modal>
  );
};
