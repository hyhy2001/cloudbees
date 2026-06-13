/**
 * listJobsRecursive — descends into folders and qualifies job names.
 */

import { describe, test, expect } from "bun:test";
import { listJobsRecursive } from "../src/plugins/job/service";
import type { CloudBeesClient } from "../src/core/api/types";

// ── Minimal fake client ────────────────────────────────────────────────────

type GetHandler = (path: string) => unknown;

class FakeClient {
  constructor(private handler: GetHandler) {}
  baseUrl = "http://fake";
  async get<T>(path: string, _opts?: unknown): Promise<T> {
    return this.handler(path) as T;
  }
}
function asClient(c: FakeClient): CloudBeesClient {
  return c as unknown as CloudBeesClient;
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const freestyleClass = "hudson.model.FreeStyleProject";
const folderClass    = "com.cloudbees.hudson.plugins.folder.Folder";

function freeJob(name: string) {
  return { _class: freestyleClass, name, url: "", color: "blue", description: "", buildable: true, lastBuild: null };
}
function folderJob(name: string) {
  return { _class: folderClass, name, url: "", color: "blue", description: "", buildable: true, lastBuild: null };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("listJobsRecursive", () => {
  test("flat list — no folders → same as listJobs", async () => {
    // The root call sends /api/json?tree=... (urlPath="" → endpoint="/api/json?tree=...")
    const c = new FakeClient((_path) => ({
      jobs: [freeJob("job-a"), freeJob("job-b")],
    }));
    const jobs = await listJobsRecursive(asClient(c));
    expect(jobs.map((j) => j.name)).toEqual(["job-a", "job-b"]);
  });

  test("descends one folder level and qualifies names", async () => {
    const c = new FakeClient((path) => {
      // root call
      if (path.startsWith("/api/json")) {
        return { jobs: [freeJob("top-job"), folderJob("my-folder")] };
      }
      // folder child call: /job/my-folder/api/json?tree=...
      if (path.startsWith("/job/my-folder")) {
        return { jobs: [freeJob("child-job")] };
      }
      return { jobs: [] };
    });
    const jobs = await listJobsRecursive(asClient(c));
    const names = jobs.map((j) => j.name);
    expect(names).toContain("top-job");
    expect(names).toContain("my-folder");
    expect(names).toContain("my-folder/child-job");
  });

  test("two levels deep", async () => {
    const c = new FakeClient((path) => {
      if (path.startsWith("/api/json")) {
        return { jobs: [folderJob("A")] };
      }
      // /job/A/job/B/api/json
      if (path.startsWith("/job/A/job/B")) {
        return { jobs: [freeJob("leaf")] };
      }
      // /job/A/api/json
      if (path.startsWith("/job/A")) {
        return { jobs: [folderJob("B")] };
      }
      return { jobs: [] };
    });
    const jobs = await listJobsRecursive(asClient(c));
    const names = jobs.map((j) => j.name);
    expect(names).toContain("A");
    expect(names).toContain("A/B");
    expect(names).toContain("A/B/leaf");
  });

  test("silently skips unreadable folders", async () => {
    const c = new FakeClient((path) => {
      // root call succeeds
      if (path.startsWith("/api/json")) {
        return { jobs: [folderJob("secret-folder")] };
      }
      // any folder child request → forbidden
      throw new Error("403 Forbidden");
    });
    const jobs = await listJobsRecursive(asClient(c));
    // The folder itself is listed, its children are skipped silently
    const names = jobs.map((j) => j.name);
    expect(names).toContain("secret-folder");
    expect(jobs).toHaveLength(1);
  });
});

