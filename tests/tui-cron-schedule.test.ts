/**
 * Pure cron-schedule helpers — buildCron / parseCron round-trip + describe.
 * React-free, no TTY.
 */

import { describe, test, expect } from "bun:test";
import {
  buildCron,
  parseCron,
  describeSchedule,
  DEFAULT_SCHEDULE,
  type ScheduleSpec,
} from "../src/core/tui/data/cron-schedule";

describe("buildCron", () => {
  test("off → empty string", () => {
    expect(buildCron({ ...DEFAULT_SCHEDULE, frequency: "off" })).toBe("");
  });
  test("hourly → minute only", () => {
    expect(buildCron({ ...DEFAULT_SCHEDULE, frequency: "hourly", minute: 15 })).toBe("15 * * * *");
  });
  test("daily → minute + hour", () => {
    expect(buildCron({ ...DEFAULT_SCHEDULE, frequency: "daily", minute: 0, hour: 8 })).toBe("0 8 * * *");
  });
  test("weekly weekdays → dow range", () => {
    expect(
      buildCron({ ...DEFAULT_SCHEDULE, frequency: "weekly", minute: 30, hour: 9, dayPreset: "weekdays" }),
    ).toBe("30 9 * * 1-5");
  });
  test("weekly single day", () => {
    expect(
      buildCron({ ...DEFAULT_SCHEDULE, frequency: "weekly", minute: 0, hour: 6, dayPreset: "mon" }),
    ).toBe("0 6 * * 1");
  });
  test("monthly → day-of-month", () => {
    expect(
      buildCron({ ...DEFAULT_SCHEDULE, frequency: "monthly", minute: 0, hour: 0, dom: 15 }),
    ).toBe("0 0 15 * *");
  });
  test("custom → trimmed raw string", () => {
    expect(buildCron({ ...DEFAULT_SCHEDULE, frequency: "custom", custom: "  H 2 * * *  " })).toBe("H 2 * * *");
  });
});

describe("parseCron", () => {
  test("empty → off", () => {
    expect(parseCron("").frequency).toBe("off");
    expect(parseCron("   ").frequency).toBe("off");
  });
  test("round-trips hourly/daily/weekly/monthly", () => {
    const cases: ScheduleSpec[] = [
      { ...DEFAULT_SCHEDULE, frequency: "hourly", minute: 15 },
      { ...DEFAULT_SCHEDULE, frequency: "daily", minute: 0, hour: 8 },
      { ...DEFAULT_SCHEDULE, frequency: "weekly", minute: 30, hour: 9, dayPreset: "weekdays" },
      { ...DEFAULT_SCHEDULE, frequency: "weekly", minute: 0, hour: 6, dayPreset: "sat" },
      { ...DEFAULT_SCHEDULE, frequency: "monthly", minute: 0, hour: 0, dom: 15 },
    ];
    for (const spec of cases) {
      const cron = buildCron(spec);
      const parsed = parseCron(cron);
      expect(buildCron(parsed)).toBe(cron);
      expect(parsed.frequency).toBe(spec.frequency);
    }
  });
  test("Jenkins H syntax falls back to custom (preserved verbatim)", () => {
    const p = parseCron("H 8 * * 1-5");
    expect(p.frequency).toBe("custom");
    expect(p.custom).toBe("H 8 * * 1-5");
  });
  test("step values fall back to custom", () => {
    const p = parseCron("*/15 * * * *");
    expect(p.frequency).toBe("custom");
  });
  test("non-* month falls back to custom", () => {
    const p = parseCron("0 8 1 6 *");
    expect(p.frequency).toBe("custom");
  });
  test("wrong field count falls back to custom", () => {
    expect(parseCron("0 8 * *").frequency).toBe("custom");
  });
});

describe("describeSchedule", () => {
  test("gives a human sentence per frequency", () => {
    expect(describeSchedule({ ...DEFAULT_SCHEDULE, frequency: "off" })).toContain("triggered");
    expect(describeSchedule({ ...DEFAULT_SCHEDULE, frequency: "daily", hour: 8, minute: 0 })).toContain("08:00");
    expect(
      describeSchedule({ ...DEFAULT_SCHEDULE, frequency: "weekly", dayPreset: "weekdays" }),
    ).toContain("Mon–Fri");
  });
});
