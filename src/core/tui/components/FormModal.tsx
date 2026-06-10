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

    // Navigation between fields.
    if (key.tab || key.downArrow) {
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
          </Box>
        );
      })}
      {error ? (
        <Box marginTop={1}>
          <Text color={THEME.error}>
            {SYM.fail} {error}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={THEME.dim}>
          Tab/↑↓ move · Enter next/submit · Esc cancel
        </Text>
      </Box>
    </Modal>
  );
};
