/**
 * Queue tracking: triggerJob parses the queue id from the Location header,
 * queueItemStateFromDict maps waiting vs running items, and waitForQueueStart
 * resolves to a build number / 'queued' / 'cancelled' / 'gone'.
 */

import { describe, test, expect } from "bun:test";
import {
  triggerJob,
  triggerJobWithParams,
  getQueueItem,
  waitForQueueStart,
} from "../src/plugins/job/service";
import { queueItemStateFromDict } from "../src/core/dtos/job";
import type { CloudBeesClient } from "../src/core/api/types";
import { NotFoundError } from "../src/core/api/errors";

// ── Minimal fake client ────────────────────────────────────────────────────

class FakeClient {
  baseUrl = "http://fake";
  postRedirectPaths: string[] = [];
  constructor(
    private opts: {
      location?: string | null;
      getHandler?: (path: string) => unknown;
    } = {},
  ) {}
  async postRedirect(path: string, _o?: unknown): Promise<string | null> {
    this.postRedirectPaths.push(path);
    return this.opts.location ?? null;
  }
  async get<T>(path: string, _o?: unknown): Promise<T> {
    if (!this.opts.getHandler) throw new Error("no get handler");
    return this.opts.getHandler(path) as T;
  }
}
function asClient(c: FakeClient): CloudBeesClient {
  return c as unknown as CloudBeesClient;
}

// ── triggerJob / triggerJobWithParams ──────────────────────────────────────

describe("triggerJob queue id parsing", () => {
  test("parses queue id from Location header", async () => {
    const c = new FakeClient({ location: "http://fake/queue/item/42/" });
    const id = await triggerJob(asClient(c), "build-api");
    expect(id).toBe(42);
    expect(c.postRedirectPaths[0]).toContain("/build");
  });

  test("returns null when Location header is absent", async () => {
    const c = new FakeClient({ location: null });
    const id = await triggerJob(asClient(c), "build-api");
    expect(id).toBeNull();
  });

  test("parameterised trigger parses queue id and hits buildWithParameters", async () => {
    const c = new FakeClient({ location: "http://fake/queue/item/7/" });
    const id = await triggerJobWithParams(asClient(c), "deploy", { ENV: "prod" });
    expect(id).toBe(7);
    expect(c.postRedirectPaths[0]).toContain("/buildWithParameters");
  });
});

// ── queueItemStateFromDict ──────────────────────────────────────────────────

describe("queueItemStateFromDict", () => {
  test("waiting item → executableNumber null, why preserved", () => {
    const s = queueItemStateFromDict({
      id: 5,
      why: "Waiting for next available executor",
      stuck: false,
      cancelled: false,
      blocked: false,
      executable: null,
    });
    expect(s.executableNumber).toBeNull();
    expect(s.why).toBe("Waiting for next available executor");
    expect(s.cancelled).toBe(false);
  });

  test("running item → executableNumber from executable.number", () => {
    const s = queueItemStateFromDict({
      id: 5,
      why: null,
      executable: { number: 42, url: "http://fake/job/x/42/" },
    });
    expect(s.executableNumber).toBe(42);
    expect(s.why).toBeNull();
  });

  test("cancelled item → cancelled true", () => {
    const s = queueItemStateFromDict({ id: 5, cancelled: true, executable: null });
    expect(s.cancelled).toBe(true);
    expect(s.executableNumber).toBeNull();
  });
});

// ── getQueueItem ────────────────────────────────────────────────────────────

describe("getQueueItem", () => {
  test("returns null on 404 (item dropped from queue)", async () => {
    const c = new FakeClient({
      getHandler: () => {
        throw new NotFoundError("gone");
      },
    });
    const state = await getQueueItem(asClient(c), 99);
    expect(state).toBeNull();
  });
});

// ── waitForQueueStart ───────────────────────────────────────────────────────

describe("waitForQueueStart", () => {
  test("returns build number once executable appears", async () => {
    const c = new FakeClient({
      getHandler: () => ({ id: 5, executable: { number: 42 } }),
    });
    const outcome = await waitForQueueStart(asClient(c), 5, 5);
    expect(outcome).toBe(42);
  });

  test("returns 'cancelled' when the item is cancelled", async () => {
    const c = new FakeClient({
      getHandler: () => ({ id: 5, cancelled: true, executable: null }),
    });
    const outcome = await waitForQueueStart(asClient(c), 5, 5);
    expect(outcome).toBe("cancelled");
  });

  test("returns 'gone' when the item 404s", async () => {
    const c = new FakeClient({
      getHandler: () => {
        throw new NotFoundError("gone");
      },
    });
    const outcome = await waitForQueueStart(asClient(c), 5, 5);
    expect(outcome).toBe("gone");
  });

  test("returns 'queued' when still waiting past the timeout", async () => {
    const c = new FakeClient({
      getHandler: () => ({ id: 5, why: "Waiting for executor", executable: null }),
    });
    // timeout 0 → loop body never runs; returns 'queued' immediately.
    const outcome = await waitForQueueStart(asClient(c), 5, 0);
    expect(outcome).toBe("queued");
  });
});
