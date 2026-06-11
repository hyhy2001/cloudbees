/**
 * Pure cron-schedule helpers for the ScheduleBuilder overlay.
 *
 *   ScheduleBuilder (overlay) ── pick frequency/time/day ──► cron string
 *                                        ▲
 *                                these pure functions
 *
 * Kept React-free so cron build/parse unit-test without a TTY (same pattern as
 * param-list / log-buffer). The builder edits a ScheduleSpec and calls buildCron
 * to produce the `<spec>` written to the job's TimerTrigger; parseCron prefills
 * the builder from an existing job's cron.
 *
 * Cron layout: "minute hour day-of-month month day-of-week".
 * We model the common cases (off / hourly / daily / weekly / monthly) with
 * explicit minute+hour for predictability; anything else round-trips as `custom`.
 */

export type Frequency = "off" | "hourly" | "daily" | "weekly" | "monthly" | "custom";

/** Day-of-week presets offered for the weekly frequency. */
export type DayPreset =
  | "weekdays"
  | "weekend"
  | "sun"
  | "mon"
  | "tue"
  | "wed"
  | "thu"
  | "fri"
  | "sat";

export interface ScheduleSpec {
  frequency: Frequency;
  minute: number; // 0-59
  hour: number; // 0-23
  dayPreset: DayPreset; // weekly only
  dom: number; // 1-31, monthly only
  custom: string; // raw cron when frequency === "custom"
}

export const DEFAULT_SCHEDULE: ScheduleSpec = {
  frequency: "off",
  minute: 0,
  hour: 8,
  dayPreset: "weekdays",
  dom: 1,
  custom: "",
};

/** DayPreset → cron day-of-week field. */
const DOW_CRON: Record<DayPreset, string> = {
  weekdays: "1-5",
  weekend: "0,6",
  sun: "0",
  mon: "1",
  tue: "2",
  wed: "3",
  thu: "4",
  fri: "5",
  sat: "6",
};

/** Human label for each day preset (for the cycler display). */
export const DAY_PRESET_LABEL: Record<DayPreset, string> = {
  weekdays: "Mon–Fri",
  weekend: "Sat–Sun",
  sun: "Sunday",
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
};

/** Ordered day-preset list for cycling. */
export const DAY_PRESETS: DayPreset[] = [
  "weekdays",
  "weekend",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];

/** Two-digit zero-pad for clock display. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Compose a cron string from a ScheduleSpec. "off" → "" (no trigger). */
export function buildCron(spec: ScheduleSpec): string {
  const { minute: m, hour: h } = spec;
  switch (spec.frequency) {
    case "off":
      return "";
    case "custom":
      return spec.custom.trim();
    case "hourly":
      return `${m} * * * *`;
    case "daily":
      return `${m} ${h} * * *`;
    case "weekly":
      return `${m} ${h} * * ${DOW_CRON[spec.dayPreset]}`;
    case "monthly":
      return `${m} ${h} ${spec.dom} * *`;
  }
}

/** Parse a plain non-negative integer, or return null if `s` isn't exactly one. */
function intOrNull(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

/**
 * Best-effort parse of a cron string back into a ScheduleSpec, for prefilling
 * the builder. Anything that doesn't fit the simple model (ranges in the time
 * fields, Jenkins `H`, step values, a non-`*` month) round-trips as `custom`
 * so the raw string is preserved and editable.
 */
export function parseCron(cron: string): ScheduleSpec {
  const spec: ScheduleSpec = { ...DEFAULT_SCHEDULE };
  const trimmed = (cron ?? "").trim();
  if (!trimmed) return spec; // off

  const asCustom = (): ScheduleSpec => ({
    ...DEFAULT_SCHEDULE,
    frequency: "custom",
    custom: trimmed,
  });

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return asCustom();
  const [min, hr, dom, mon, dow] = parts as [string, string, string, string, string];

  // Our simple model only covers month = "*".
  if (mon !== "*") return asCustom();

  const minN = intOrNull(min);
  if (minN === null) return asCustom();
  spec.minute = minN;

  // Monthly: day-of-month set, day-of-week unused.
  if (dom !== "*") {
    const domN = intOrNull(dom);
    const hrN = intOrNull(hr);
    if (domN === null || hrN === null || dow !== "*") return asCustom();
    spec.frequency = "monthly";
    spec.dom = domN;
    spec.hour = hrN;
    return spec;
  }

  // Weekly: day-of-week set to one of our presets.
  if (dow !== "*") {
    const preset = (Object.keys(DOW_CRON) as DayPreset[]).find((k) => DOW_CRON[k] === dow);
    const hrN = intOrNull(hr);
    if (!preset || hrN === null) return asCustom();
    spec.frequency = "weekly";
    spec.dayPreset = preset;
    spec.hour = hrN;
    return spec;
  }

  // Daily: a specific hour, every day.
  if (hr !== "*") {
    const hrN = intOrNull(hr);
    if (hrN === null) return asCustom();
    spec.frequency = "daily";
    spec.hour = hrN;
    return spec;
  }

  // Minute set, everything else "*": hourly.
  spec.frequency = "hourly";
  return spec;
}

/** A short human summary of a spec, shown beneath the cron preview. */
export function describeSchedule(spec: ScheduleSpec): string {
  const at = `${pad2(spec.hour)}:${pad2(spec.minute)}`;
  switch (spec.frequency) {
    case "off":
      return "No schedule — runs only when triggered.";
    case "custom":
      return spec.custom.trim() ? "Custom cron expression." : "Custom (empty).";
    case "hourly":
      return `Every hour at :${pad2(spec.minute)}.`;
    case "daily":
      return `Every day at ${at}.`;
    case "weekly":
      return `Every ${DAY_PRESET_LABEL[spec.dayPreset]} at ${at}.`;
    case "monthly":
      return `Day ${spec.dom} of every month at ${at}.`;
  }
}
