/**
 * listApprovedFolders — parses the controlled-agent approved-folders HTML table.
 *
 * The folder href regex must not be greedy: a nested approved folder renders as
 * href="/job/TeamA/job/ProjectX/" and a greedy `[^"]*` collapses it to just
 * "ProjectX", producing a false "build will stay PENDING" warning for the common
 * nested-folder case. These tests assert both flat and nested paths parse whole.
 */

import { describe, test, expect } from "bun:test";
import { listApprovedFolders } from "../src/plugins/node/service";
import type { CloudBeesClient } from "../src/core/api/types";

class FakeClient {
  constructor(private html: string) {}
  baseUrl = "http://fake";
  async get<T>(_path: string, _opts?: unknown): Promise<T> {
    return this.html as unknown as T;
  }
}

function asClient(html: string): CloudBeesClient {
  return new FakeClient(html) as unknown as CloudBeesClient;
}

// One row per approved folder, mirroring the real security-tokens table shape:
// a tokensById delete link (for the tokenId) plus a /job/…/ link (for the name).
function row(jobHref: string, label: string, tokenId: string): string {
  return `<tr>
    <td><a href="/job/${jobHref}/">${label}</a></td>
    <td><a href="/computer/agent/security-tokens/tokensById/${tokenId}/delete">Revoke</a></td>
  </tr>`;
}

describe("listApprovedFolders", () => {
  test("flat folder path parses whole", async () => {
    const html = `<table>${row("ProjectX", "ProjectX", "tok1")}</table>`;
    const r = await listApprovedFolders(asClient(html), "agent");
    expect(r).toEqual([{ folderName: "ProjectX", tokenId: "tok1" }]);
  });

  test("nested folder path keeps every segment (regression: greedy regex dropped the prefix)", async () => {
    const html = `<table>${row("TeamA/job/ProjectX", "ProjectX", "tok2")}</table>`;
    const r = await listApprovedFolders(asClient(html), "agent");
    // Greedy `[^"]*` collapsed this to "ProjectX"; lazy match keeps "TeamA/ProjectX".
    expect(r).toEqual([{ folderName: "TeamA/ProjectX", tokenId: "tok2" }]);
  });

  test("deeply nested folder path keeps all segments", async () => {
    const html = `<table>${row("TeamA/job/SubTeam/job/ProjectX", "ProjectX", "tok3")}</table>`;
    const r = await listApprovedFolders(asClient(html), "agent");
    expect(r).toEqual([{ folderName: "TeamA/SubTeam/ProjectX", tokenId: "tok3" }]);
  });

  test("multiple rows, mixed flat and nested", async () => {
    const html = `<table>
      ${row("Flat", "Flat", "t1")}
      ${row("TeamA/job/Nested", "Nested", "t2")}
    </table>`;
    const r = await listApprovedFolders(asClient(html), "agent");
    expect(r).toEqual([
      { folderName: "Flat", tokenId: "t1" },
      { folderName: "TeamA/Nested", tokenId: "t2" },
    ]);
  });
});
