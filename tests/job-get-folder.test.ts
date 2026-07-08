/**
 * getJob — must resolve a folder-qualified job even when the direct endpoint
 * doesn't return it, by falling back to the RECURSIVE listing (not the flat
 * root listing, which never contains folder children).
 *
 * Regression: deploy re-created existing folder jobs -> HTTP 400, because
 * getJob("RX_AUTO/build_user01") fell back to listJobs() (root only) and never
 * matched, so callers thought the job was absent.
 */
import { describe, test, expect } from "bun:test";
import { getJob } from "../src/plugins/job/service";
import type { CloudBeesClient } from "../src/core/api/types";
import { NotFoundError } from "../src/core/api/errors";

const freestyleClass = "hudson.model.FreeStyleProject";
const folderClass = "com.cloudbees.hudson.plugins.folder.Folder";
const freeJob = (name: string) => ({
  _class: freestyleClass, name, url: "", color: "blue", description: "", buildable: true, lastBuild: null,
});
const folderJob = (name: string) => ({
  _class: folderClass, name, url: "", color: "blue", description: "", buildable: true, lastBuild: null,
});

class FakeClient {
  constructor(private handler: (path: string) => unknown) {}
  baseUrl = "http://fake";
  async get<T>(path: string, _opts?: unknown): Promise<T> {
    return this.handler(path) as T;
  }
}
const asClient = (c: FakeClient) => c as unknown as CloudBeesClient;

describe("getJob folder resolution", () => {
  test("finds a folder job via recursive fallback when direct endpoint is empty", async () => {
    const c = new FakeClient((path) => {
      // Direct endpoint for the folder job returns nothing (null) — the case
      // that used to break: falsy directData, no throw.
      if (path.startsWith("/job/RX_AUTO/job/build_user01/api/json")) return null;
      // Root listing: only the folder itself, NOT its children.
      if (path.startsWith("/api/json")) return { jobs: [folderJob("RX_AUTO")] };
      // Folder child listing (recursive descent).
      if (path.startsWith("/job/RX_AUTO/api/json")) return { jobs: [freeJob("build_user01")] };
      throw new NotFoundError(path);
    });
    const job = await getJob(asClient(c), "RX_AUTO/build_user01");
    expect(job?.name).toBe("RX_AUTO/build_user01");
  });

  test("returns null for a genuinely absent folder job", async () => {
    const c = new FakeClient((path) => {
      if (path.startsWith("/job/RX_AUTO/job/nope/api/json")) return null;
      if (path.startsWith("/api/json")) return { jobs: [folderJob("RX_AUTO")] };
      if (path.startsWith("/job/RX_AUTO/api/json")) return { jobs: [freeJob("build_user01")] };
      throw new NotFoundError(path);
    });
    const job = await getJob(asClient(c), "RX_AUTO/nope");
    expect(job).toBeNull();
  });
});
