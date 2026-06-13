/**
 * jobPathSegments — folder/job path encoding for Jenkins REST API.
 *
 * Jenkins uses /job/ as the separator between folder hierarchy levels,
 * so "folder/sub/job" must become "folder/job/sub/job/job" (each segment
 * individually URL-encoded). A flat name is just encodeURIComponent of itself.
 */

import { describe, test, expect } from "bun:test";
import { jobPathSegments } from "../src/plugins/job/service";

describe("jobPathSegments", () => {
  test("plain name — no slash", () => {
    expect(jobPathSegments("my-job")).toBe("my-job");
  });

  test("name with spaces", () => {
    expect(jobPathSegments("my job")).toBe("my%20job");
  });

  test("one folder level", () => {
    expect(jobPathSegments("folder/job")).toBe("folder/job/job");
  });

  test("two folder levels", () => {
    expect(jobPathSegments("a/b/c")).toBe("a/job/b/job/c");
  });

  test("folder segments with spaces", () => {
    expect(jobPathSegments("my folder/my job")).toBe("my%20folder/job/my%20job");
  });

  test("special characters in name", () => {
    expect(jobPathSegments("job (test)")).toBe("job%20(test)");
  });

  test("three levels deep", () => {
    expect(jobPathSegments("a/b/c/d")).toBe("a/job/b/job/c/job/d");
  });

  test("path used in API URL prefix", () => {
    const seg = jobPathSegments("team/deploy");
    expect(`/job/${seg}/api/json`).toBe("/job/team/job/deploy/api/json");
  });
});
