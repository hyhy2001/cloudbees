/**
 * Email anti-spam filter behavior contract.
 * Ports legacy/cb/testsuite/test_email_filters.py to Bun's test runner.
 *
 * The contract (also documented in README):
 *  - keywords + regex metadata is embedded in the presendScript marker line
 *  - partial updates preserve untouched fields (email, regex)
 *  - clearing one filter dimension keeps the other
 *  - a filter without a recipient email fails fast (throws)
 *  - clearing all filters without a recipient is a safe no-op (publisher dropped)
 */

import { test, expect, describe } from "bun:test";
import { XMLParser } from "fast-xml-parser";
import { buildFreestyleXml, parseEmailFilterMetadata } from "../src/plugins/job/xml-builder";
import { createFreestyleJob, updateJobFreestyle } from "../src/plugins/job/service";
import type { CloudBeesClient } from "../src/core/api/types";

// ── Fake client ────────────────────────────────────────────────────────────
// Captures postXml calls and serves a canned config.xml for getText.
class FakeClient {
  configXml: string;
  posted: Array<{ path: string; xml: string; invalidate?: string }> = [];

  constructor(configXml = "") {
    this.configXml = configXml;
  }

  async getText(_path: string): Promise<string> {
    return this.configXml;
  }

  async postXml(path: string, xml: string, opts?: { invalidate?: string }): Promise<string | null> {
    this.posted.push({ path, xml, invalidate: opts?.invalidate });
    return null;
  }
}

function asClient(fake: FakeClient): CloudBeesClient {
  return fake as unknown as CloudBeesClient;
}

// ── XML extraction helpers ───────────────────────────────────────────────────
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

function extractPublisher(xmlText: string): Record<string, unknown> | null {
  const doc = parser.parse(xmlText) as Record<string, unknown>;
  const project = doc["project"] as Record<string, unknown> | undefined;
  if (!project) return null;
  const publishers = project["publishers"] as Record<string, unknown> | undefined;
  if (!publishers) return null;
  const ext = publishers["hudson.plugins.emailext.ExtendedEmailPublisher"] as
    | Record<string, unknown>
    | undefined;
  return ext ?? null;
}

function extractMeta(xmlText: string) {
  const ext = extractPublisher(xmlText);
  expect(ext).not.toBeNull();
  const presend = ext!["presendScript"];
  return parseEmailFilterMetadata(presend == null ? null : String(presend));
}

function extractRecipient(xmlText: string): string {
  const ext = extractPublisher(xmlText);
  expect(ext).not.toBeNull();
  const recipient = ext!["recipientList"];
  return (recipient == null ? "" : String(recipient)).trim();
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("email filters", () => {
  test("build with filter embeds metadata and script", () => {
    const xml = buildFreestyleXml({
      desc: "d",
      shellCmd: "echo hi",
      email: "ops@example.com",
      emailCond: "failed",
      emailKeywords: ["CRITICAL", "panic"],
      emailRegex: "OOM|OutOfMemory",
    });
    const meta = extractMeta(xml);
    expect(meta).not.toBeNull();
    expect(meta!.keywords).toEqual(["CRITICAL", "panic"]);
    expect(meta!.regex).toBe("OOM|OutOfMemory");
    expect(meta!.case_sensitive).toBe(false);
  });

  test("build without filter keeps default presend script", () => {
    const xml = buildFreestyleXml({
      desc: "d",
      shellCmd: "echo hi",
      email: "ops@example.com",
      emailCond: "failed",
    });
    const ext = extractPublisher(xml);
    expect(ext).not.toBeNull();
    expect(String(ext!["presendScript"])).toBe("$DEFAULT_PRESEND_SCRIPT");
  });

  test("partial update keeps existing email and regex", async () => {
    const existing = buildFreestyleXml({
      shellCmd: "echo old",
      email: "ops@example.com",
      emailCond: "failed",
      emailKeywords: ["OLD"],
      emailRegex: "OOM",
    });
    const client = new FakeClient(existing);

    await updateJobFreestyle(
      asClient(client),
      "demo",
      undefined, // desc
      undefined, // shellCmd
      undefined, // node
      undefined, // schedule
      undefined, // email
      undefined, // emailCond
      ["NEW", "panic"], // emailKeywords
    );

    expect(client.posted.length).toBe(1);
    const postedXml = client.posted[0]!.xml;
    expect(extractRecipient(postedXml)).toBe("ops@example.com");

    const meta = extractMeta(postedXml);
    expect(meta).not.toBeNull();
    expect(meta!.keywords).toEqual(["NEW", "panic"]);
    expect(meta!.regex).toBe("OOM");
  });

  test("clear regex keeps keywords", async () => {
    const existing = buildFreestyleXml({
      shellCmd: "echo old",
      email: "ops@example.com",
      emailCond: "failed",
      emailKeywords: ["ALERT"],
      emailRegex: "OOM",
    });
    const client = new FakeClient(existing);

    await updateJobFreestyle(
      asClient(client),
      "demo",
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, // emailKeywords
      undefined, // emailRegex
      false, // clearEmailKeywords
      true, // clearEmailRegex
    );

    const postedXml = client.posted[0]!.xml;
    const meta = extractMeta(postedXml);
    expect(meta).not.toBeNull();
    expect(meta!.keywords).toEqual(["ALERT"]);
    expect(meta!.regex).toBeNull();
  });

  test("filter without recipient fails fast (create + update)", async () => {
    const createClient = new FakeClient();
    let createThrew = false;
    try {
      await createFreestyleJob(
        asClient(createClient),
        "n1",
        "", // desc
        "echo hi", // shellCmd
        null, null, null,
        null, // email
        "failed",
        ["CRITICAL"], // emailKeywords
      );
    } catch {
      createThrew = true;
    }
    expect(createThrew).toBe(true);

    const existing = buildFreestyleXml({ shellCmd: "echo hi", email: null });
    const updateClient = new FakeClient(existing);
    let updateThrew = false;
    try {
      await updateJobFreestyle(
        asClient(updateClient),
        "n1",
        undefined, undefined, undefined, undefined, undefined, undefined,
        ["CRITICAL"], // emailKeywords
      );
    } catch {
      updateThrew = true;
    }
    expect(updateThrew).toBe(true);
  });

  test("clear filter flags without recipient is a safe no-op", async () => {
    const existing = buildFreestyleXml({ shellCmd: "echo hi", email: null });
    const client = new FakeClient(existing);

    await updateJobFreestyle(
      asClient(client),
      "n1",
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      true, // clearEmailKeywords
      true, // clearEmailRegex
    );

    const postedXml = client.posted[0]!.xml;
    const ext = extractPublisher(postedXml);
    expect(ext).toBeNull();
  });
});
