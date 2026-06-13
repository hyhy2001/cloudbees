/**
 * buildSecretTextCredXml — SecretText credential XML builder.
 */

import { describe, test, expect } from "bun:test";
import { buildSecretTextCredXml } from "../src/plugins/credential/xml-builder";

describe("buildSecretTextCredXml", () => {
  test("produces the correct root element", () => {
    const xml = buildSecretTextCredXml("my-id", "s3cr3t");
    expect(xml).toContain("<org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl>");
    expect(xml).toContain("</org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl>");
  });

  test("includes all child elements in correct order", () => {
    const xml = buildSecretTextCredXml("cred-1", "mysecret", "my desc", "SYSTEM");
    const scopeIdx    = xml.indexOf("<scope>SYSTEM</scope>");
    const idIdx       = xml.indexOf("<id>cred-1</id>");
    const descIdx     = xml.indexOf("<description>my desc</description>");
    const secretIdx   = xml.indexOf("<secret>mysecret</secret>");

    expect(scopeIdx).toBeGreaterThan(-1);
    expect(idIdx).toBeGreaterThan(scopeIdx);
    expect(descIdx).toBeGreaterThan(idIdx);
    expect(secretIdx).toBeGreaterThan(descIdx);
  });

  test("defaults scope=GLOBAL and desc=empty", () => {
    const xml = buildSecretTextCredXml("id1", "val");
    expect(xml).toContain("<scope>GLOBAL</scope>");
    expect(xml).toContain("<description></description>");
  });

  test("XML-escapes special characters in secret", () => {
    const xml = buildSecretTextCredXml("id2", "a&b<c>d\"e'f");
    expect(xml).toContain("<secret>a&amp;b&lt;c&gt;d&quot;e&apos;f</secret>");
  });

  test("XML-escapes special characters in description and id", () => {
    const xml = buildSecretTextCredXml("id<x>", "val", "desc & more");
    expect(xml).toContain("<id>id&lt;x&gt;</id>");
    expect(xml).toContain("<description>desc &amp; more</description>");
  });

  test("starts with XML 1.1 declaration", () => {
    const xml = buildSecretTextCredXml("x", "y");
    expect(xml.startsWith("<?xml version='1.1' encoding='UTF-8'?>")).toBe(true);
  });
});
