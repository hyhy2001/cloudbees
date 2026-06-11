/**
 * FormModal — a sequential multi-field text form rendered as a modal.
 * Port of the create-job / create-node / create-credential / login modals.
 *
 * Fields are filled top to bottom. Tab / Enter moves to the next field;
 * on the last field, Enter submits. Esc cancels. A field marked `password`
 * renders its value masked. A field with `options` cycles with ←/→.
 *
 * Deliberately dependency-free (no ink-text-input): a small useInput handler
 * covers the editing we need (printable chars + backspace).
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Modal } from "./Modal";
import { THEME } from "../theme";
import { SYM } from "../symbols";
import { completePath } from "../data/path-complete";

export interface FormField {
  /** Stable key used in the result object. */
  name: string;
  /** Visible label. */
  label: string;
  /** Placeholder shown when empty. */
  placeholder?: string;
  /** Mask the value (passwords). */
  password?: boolean;
  /** If set, the field is a cycler over these options (←/→) rather than free text. */
  options?: string[];
  /** Initial value (or initial option for option fields). */
  initial?: string;
  /** Field must be non-empty to submit. */
  required?: boolean;
  /** Short guidance shown dimmed to the right of the field (how to fill it). */
  hint?: string;
  /**
   * Free-text field that completes against the LOCAL filesystem on Tab. The
   * machine running bee browses its own FS — only literally correct for an agent
   * on this same host. Completion is convenience; the typed string is sent as-is.
   */
  path?: boolean;
}

/** Props for FormModal. `onResult` receives the filled values, or null on cancel. */
export interface FormModalProps {
  title: string;
  fields: FormField[];
  onResult: (values: Record<string, string> | null) => void;
}

/** Sequential multi-field form rendered as a modal overlay. */
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
  // Candidate basenames from the last path-completion (shown as a hint).
  const [candidates, setCandidates] = useState<string[]>([]);

  const field = fields[cursor]!;

  function setFieldValue(name: string, value: string): void {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  function submit(): void {
    for (const f of fields) {
      if (f.required && !values[f.name]?.trim()) {
        setError(`${f.label} is required`);
        // jump cursor to the offending field
        setCursor(fields.indexOf(f));
        return;
      }
    }
    onResult(values);
  }

  useInput((input, key) => {
    if (key.escape) {
      onResult(null);
      return;
    }

    // Option cycler fields: ←/→ to change.
    if (field.options) {
      const opts = field.options;
      const idx = opts.indexOf(values[field.name] ?? opts[0]!);
      if (key.leftArrow) {
        setFieldValue(field.name, opts[(idx - 1 + opts.length) % opts.length]!);
        return;
      }
      if (key.rightArrow) {
        setFieldValue(field.name, opts[(idx + 1) % opts.length]!);
        return;
      }
    }

    // Tab on a path field completes against the local FS instead of moving on.
    if (key.tab && field.path && !field.options) {
      const { completed, candidates: cands } = completePath(values[field.name] ?? "");
      setFieldValue(field.name, completed);
      setCandidates(cands.slice(0, 12));
      return;
    }

    // Navigation between fields.
    if (key.tab || key.downArrow) {
      setCandidates([]);
      setCursor((c) => Math.min(c + 1, fields.length - 1));
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(c - 1, 0));
      return;
    }
    if (key.return) {
      if (cursor < fields.length - 1) {
        setCursor((c) => c + 1);
      } else {
        submit();
      }
      return;
    }

    // Free-text editing (skip for option fields).
    if (!field.options) {
      if (key.backspace || key.delete) {
        setFieldValue(field.name, (values[field.name] ?? "").slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFieldValue(field.name, (values[field.name] ?? "") + input);
      }
    }
  });

  return (
    <Modal title={title}>
      {fields.map((f, i) => {
        const isActive = i === cursor;
        const raw = values[f.name] ?? "";
        const shown = f.password ? "*".repeat(raw.length) : raw;
        const display = shown || (f.placeholder ? `${f.placeholder}` : "");
        const isPlaceholder = !shown && !!f.placeholder;
        return (
          <Box key={f.name}>
            <Text color={isActive ? THEME.active : THEME.dim}>
              {isActive ? SYM.arrow : " "} {f.label.padEnd(16)}
            </Text>
            {f.options ? (
              <Text color={THEME.normal}>
                {SYM.arrow} {shown} {SYM.arrow}
              </Text>
            ) : (
              <Text color={isPlaceholder ? THEME.dim : THEME.normal}>
                {display}
                {isActive ? "_" : ""}
              </Text>
            )}
            {f.hint ? (
              <Text color={THEME.dim}>
                {"   "}
                {f.hint}
              </Text>
            ) : null}
          </Box>
        );
      })}
      {candidates.length > 0 && field.path ? (
        <Box marginTop={1}>
          <Text color={THEME.dim} wrap="truncate-end">
            {candidates.join("  ")}
          </Text>
        </Box>
      ) : null}
      {error ? (
        <Box marginTop={1}>
          <Text color={THEME.error}>
            {SYM.fail} {error}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={THEME.dim}>
          {field.path ? "Tab complete · ↑↓ move" : "Tab/↑↓ move"} · Enter next/submit · Esc cancel
        </Text>
      </Box>
    </Modal>
  );
};
