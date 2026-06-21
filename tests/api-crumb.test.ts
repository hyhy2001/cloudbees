/**
 * CSRF crumb tests — core/api/crumb.ts.
 * Tests the in-memory TTL cache and fallback behavior.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { getCrumb, invalidateCrumb } from "../src/core/api/crumb";

interface CrumbClient {
  baseUrl: string;
  _rawGet(path: string): Promise<unknown>;
}

function makeClient(handler: (path: string) => unknown, baseUrl = "http://jenkins.example.com"): CrumbClient {
  return {
    baseUrl,
    async _rawGet(path: string): Promise<unknown> {
      return handler(path);
    },
  };
}

// Track crumb cache state across tests — shared module-level Map.
// Each test starts fresh by invalidating the crumb for the test URL.
beforeEach(() => {
  invalidateCrumb("http://jenkins.example.com");
  invalidateCrumb("http://jenkins2.example.com");
});

describe("getCrumb", () => {
  test("returns crumb data when server responds", async () => {
    const client = makeClient(() => ({
      crumb: "abc123",
      crumbRequestField: "Jenkins-Crumb",
    }));
    const result = await getCrumb(client);
    expect(result).toEqual({ field: "Jenkins-Crumb", value: "abc123" });
  });

  test("caches crumb for repeated calls (same client)", async () => {
    let callCount = 0;
    const client = makeClient(() => {
      callCount++;
      return { crumb: "abc", crumbRequestField: "Jenkins-Crumb" };
    });
    await getCrumb(client);
    await getCrumb(client);
    await getCrumb(client);
    // Only one actual fetch; subsequent calls hit the in-memory cache.
    expect(callCount).toBe(1);
  });

  test("returns null when server responds without crumb field", async () => {
    const client = makeClient(() => ({}));
    const result = await getCrumb(client);
    expect(result).toBeNull();
  });

  test("returns null when server responds with non-string crumb", async () => {
    const client = makeClient(() => ({ crumb: 123 }));
    const result = await getCrumb(client);
    expect(result).toBeNull();
  });

  test("returns null when _rawGet throws (CSRF disabled)", async () => {
    const client = makeClient(() => { throw new Error("not found"); });
    const result = await getCrumb(client);
    expect(result).toBeNull();
  });

  test("invalidateCrumb clears the cache entry", async () => {
    let callCount = 0;
    const client = makeClient(() => {
      callCount++;
      return { crumb: "abc", crumbRequestField: "Jenkins-Crumb" };
    });
    await getCrumb(client);
    invalidateCrumb(client.baseUrl);
    await getCrumb(client);
    // Cache was cleared, so the second call re-fetches.
    expect(callCount).toBe(2);
  });

  test("different baseUrls have independent caches", async () => {
    let callsA = 0, callsB = 0;
    const clientA = makeClient(() => { callsA++; return { crumb: "a", crumbRequestField: "Jenkins-Crumb" }; }, "http://server-a.example.com");
    const clientB = makeClient(() => { callsB++; return { crumb: "b", crumbRequestField: "Jenkins-Crumb" }; }, "http://server-b.example.com");
    await getCrumb(clientA);
    await getCrumb(clientB);
    await getCrumb(clientA);
    await getCrumb(clientB);
    expect(callsA).toBe(1);
    expect(callsB).toBe(1);
  });
});
