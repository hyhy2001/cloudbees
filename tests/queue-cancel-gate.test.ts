/**
 * queueItemMatchesJob — the ownership gate for `bee job queue cancel`.
 *
 * You may only cancel queued builds of jobs you track, so one user can't cancel
 * another user's work on the shared controller. The match is on the queue item's
 * task URL (folder-qualified job path), compared for EXACT equality against the
 * tracked name — an earlier substring/suffix match let a nested job like `a/b/c`
 * match a shorter tracked name `b/c` and defeat the gate.
 */

import { describe, test, expect } from "bun:test";
import { queueItemMatchesJob, jobPathFromTaskUrl } from "../src/plugins/job/commands";

const HOST = "https://ci.example.com";

function item(path: string) {
  return { taskName: path.split("/").pop() ?? path, taskUrl: `${HOST}${path}` };
}

describe("jobPathFromTaskUrl", () => {
  test("flat job", () => {
    expect(jobPathFromTaskUrl(`${HOST}/job/build_x/`)).toBe("build_x");
  });
  test("nested folder path", () => {
    expect(jobPathFromTaskUrl(`${HOST}/job/TeamA/job/build_x/`)).toBe("TeamA/build_x");
  });
  test("deeply nested", () => {
    expect(jobPathFromTaskUrl(`${HOST}/job/a/job/b/job/c/`)).toBe("a/b/c");
  });
  test("url-encoded segment is decoded", () => {
    expect(jobPathFromTaskUrl(`${HOST}/job/Team%20A/job/build_x/`)).toBe("Team A/build_x");
  });
  test("no /job/ segments → null", () => {
    expect(jobPathFromTaskUrl(`${HOST}/queue/item/5/`)).toBeNull();
  });
});

describe("queueItemMatchesJob ownership gate", () => {
  test("exact flat name matches", () => {
    expect(queueItemMatchesJob(item("/job/build_x/"), "build_x")).toBe(true);
  });

  test("exact folder-qualified name matches", () => {
    expect(queueItemMatchesJob(item("/job/TeamA/job/build_x/"), "TeamA/build_x")).toBe(true);
  });

  test("nested job a/b/c does NOT match shorter tracked name b/c (the bypass)", () => {
    // The regression: a suffix/substring match treated `b/c` as owning `a/b/c`.
    expect(queueItemMatchesJob(item("/job/a/job/b/job/c/"), "b/c")).toBe(false);
  });

  test("nested job a/b/c does NOT match leaf name c", () => {
    expect(queueItemMatchesJob(item("/job/a/job/b/job/c/"), "c")).toBe(false);
  });

  test("flat job build_x does NOT match a folder-qualified name", () => {
    expect(queueItemMatchesJob(item("/job/build_x/"), "TeamA/build_x")).toBe(false);
  });

  test("sibling jobs sharing a suffix don't cross-match", () => {
    expect(queueItemMatchesJob(item("/job/TeamA/job/build_x/"), "TeamB/build_x")).toBe(false);
  });

  test("fallback: empty taskUrl matches on exact taskName", () => {
    expect(queueItemMatchesJob({ taskName: "build_x", taskUrl: "" }, "build_x")).toBe(true);
  });

  test("fallback does not fire when taskName differs", () => {
    expect(queueItemMatchesJob({ taskName: "other", taskUrl: "" }, "build_x")).toBe(false);
  });
});
