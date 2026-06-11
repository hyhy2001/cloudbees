/**
 * ScheduleBuilder — a full-screen overlay that lets users build a job's cron
 * schedule visually instead of typing raw cron. Rendered in place of a screen
 * (like LogViewer / ParamListEditor) and owns all input via ctx.setInputCaptured.
 *
 *   ↑/↓ (or j/k) move between rows · ←/→ change the focused value
 *   on the Custom row, type the raw cron · Enter save · Esc cancel
 *
 * Returns the composed cron string ("" for "off"). The cron build/parse logic
 * is the pure helpers in domain/schedule; this is the interactive shell.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { FC } from "react";
import { Modal } from "./Modal";
import { THEME } from "../theme";
import { SYM } from "../symbols";
import {
  buildCron,
  describeSchedule,
  DAY_PRESETS,
  DAY_PRESET_LABEL,
  type ScheduleSpec,
  type Frequency,
  type DayPreset,
} from "../../../domain/schedule";

export interface ScheduleBuilderProps {
  /** Starting spec (parse an existing job's cron with parseCron, or DEFAULT_SCHEDULE). */
  initial: ScheduleSpec;
  /** Called with the composed cron string on confirm ("" = no schedule), or null on cancel. */
  onResult: (cron: string | null) => void;
  /** Mark the overlay as owning input (suspends shell global keys). */
  setInputCaptured: (captured: boolean) => void;
}

const FREQUENCIES: Frequency[] = ["off", "hourly", "daily", "weekly", "monthly", "custom"];
const FREQ_LABEL: Record<Frequency, string> = {
  off: "Off (manual only)",
  hourly: "Hourly",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  custom: "Custom cron",
};

type RowKind = "frequency" | "hour" | "minute" | "day" | "dom" | "custom";

/** Which control rows are shown for a given frequency. */
function rowsFor(freq: Frequency): RowKind[] {
  switch (freq) {
    case "off":
      return ["frequency"];
    case "hourly":
      return ["frequency", "minute"];
    case "daily":
      return ["frequency", "hour", "minute"];
    case "weekly":
      return ["frequency", "hour", "minute", "day"];
    case "monthly":
      return ["frequency", "hour", "minute", "dom"];
    case "custom":
      return ["frequency", "custom"];
  }
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const wrap = (n: number, max: number): number => ((n % max) + max) % max; // 0..max-1

/** Full-screen visual cron schedule builder overlay. */
export const ScheduleBuilder: FC<ScheduleBuilderProps> = ({
  initial,
  onResult,
  setInputCaptured,
}) => {
  const [spec, setSpec] = useState<ScheduleSpec>(initial);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    setInputCaptured(true);
    return () => setInputCaptured(false);
  }, [setInputCaptured]);

  const rows = rowsFor(spec.frequency);
  const row = rows[Math.min(cursor, rows.length - 1)]!;

  // Change the focused row's value by `dir` (-1 / +1).
  const change = (dir: number) => {
    setSpec((s) => {
      switch (row) {
        case "frequency": {
          const i = FREQUENCIES.indexOf(s.frequency);
          const next = FREQUENCIES[wrap(i + dir, FREQUENCIES.length)]!;
          return { ...s, frequency: next };
        }
        case "hour":
          return { ...s, hour: wrap(s.hour + dir, 24) };
        case "minute":
          return { ...s, minute: wrap(s.minute + dir, 60) };
        case "day": {
          const i = DAY_PRESETS.indexOf(s.dayPreset);
          const next = DAY_PRESETS[wrap(i + dir, DAY_PRESETS.length)]! as DayPreset;
          return { ...s, dayPreset: next };
        }
        case "dom":
          // 1..31
          return { ...s, dom: wrap(s.dom - 1 + dir, 31) + 1 };
        default:
          return s;
      }
    });
    // Changing frequency can shrink the row list; clamp on next render via cursor guard.
    if (row === "frequency") setCursor(0);
  };

  useInput((input, key) => {
    if (key.escape) {
      onResult(null);
      return;
    }
    if (key.return) {
      onResult(buildCron(spec));
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
    // On the custom row, printable input edits the raw cron string.
    if (row === "custom") {
      if (key.backspace || key.delete) {
        setSpec((s) => ({ ...s, custom: s.custom.slice(0, -1) }));
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.leftArrow && !key.rightArrow) {
        setSpec((s) => ({ ...s, custom: s.custom + input }));
        return;
      }
    }
    if (key.leftArrow) {
      change(-1);
      return;
    }
    if (key.rightArrow) {
      change(1);
      return;
    }
    // j/k move between rows (safe: never reached on the custom text row above).
    if (input === "k") setCursor((c) => Math.max(0, c - 1));
    else if (input === "j") setCursor((c) => Math.min(rows.length - 1, c + 1));
  });

  const cron = buildCron(spec);

  // Render one control row with its label + current value.
  const renderRow = (kind: RowKind, idx: number) => {
    const on = idx === Math.min(cursor, rows.length - 1);
    let label = "";
    let value = "";
    switch (kind) {
      case "frequency":
        label = "Frequency";
        value = FREQ_LABEL[spec.frequency];
        break;
      case "hour":
        label = "Hour";
        value = pad2(spec.hour);
        break;
      case "minute":
        label = "Minute";
        value = pad2(spec.minute);
        break;
      case "day":
        label = "Day";
        value = DAY_PRESET_LABEL[spec.dayPreset];
        break;
      case "dom":
        label = "Day of month";
        value = String(spec.dom);
        break;
      case "custom":
        label = "Custom cron";
        value = `${spec.custom}${on ? "_" : ""}`;
        break;
    }
    const cycler = kind !== "custom";
    return (
      <Box key={kind}>
        <Text color={on ? THEME.active : THEME.dim}>
          {on ? SYM.arrow : " "} {label.padEnd(14)}
        </Text>
        <Text color={THEME.normal}>
          {cycler && on ? `${SYM.arrow} ` : ""}
          {value}
          {cycler && on ? ` ${SYM.arrow}` : ""}
        </Text>
      </Box>
    );
  };

  return (
    <Modal title={`${SYM.gear} Schedule Builder`}>
      {rows.map((kind, idx) => renderRow(kind, idx))}
      <Box marginTop={1} flexDirection="column">
        <Text color={THEME.dim}>{describeSchedule(spec)}</Text>
        <Text>
          <Text color={THEME.dim}>cron: </Text>
          <Text color={THEME.keyhint}>{cron || "(none)"}</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={THEME.dim}>↑↓ move · ←→ change · Enter save · Esc cancel</Text>
      </Box>
    </Modal>
  );
};
