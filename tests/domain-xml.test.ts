/**
 * Domain layer tests — XML escaping.
 */
import { describe, test, expect } from "bun:test";
import { escapeXml, xmlParser, xmlParserTagValues } from "../src/domain/xml";

describe("escapeXml", () => {
  test("escapes & → &amp;", () => {
    expect(escapeXml("a&b")).toBe("a&amp;b");
  });

  test("escapes < → &lt;", () => {
    expect(escapeXml("<tag>")).toBe("&lt;tag&gt;");
  });

  test("escapes > → &gt;", () => {
    expect(escapeXml("a > b")).toBe("a &gt; b");
  });

  test("escapes double quote → &quot;", () => {
    expect(escapeXml('say "hello"')).toBe("say &quot;hello&quot;");
  });

  test("escapes single quote → &apos;", () => {
    expect(escapeXml("it's")).toBe("it&apos;s");
  });

  test("escapes all five in one string", () => {
    expect(escapeXml("<a x=\"1\" y='2'>&amp;")).toBe("&lt;a x=&quot;1&quot; y=&apos;2&apos;&gt;&amp;amp;");
  });

  test("empty string returns empty", () => {
    expect(escapeXml("")).toBe("");
  });

  test("string with no special chars returns unchanged", () => {
    expect(escapeXml("hello world 123")).toBe("hello world 123");
  });

  test("multiple occurrences of same entity", () => {
    expect(escapeXml("<<<")).toBe("&lt;&lt;&lt;");
  });

  test("Unicode characters are preserved", () => {
    expect(escapeXml("café 🐝")).toBe("café 🐝");
  });
});

describe("xmlParser singletons", () => {
  test("xmlParser parses without collapsing tag values", () => {
    const doc = xmlParser.parse("<root><value>123</value></root>") as Record<string, unknown>;
    expect(doc).toBeDefined();
  });

  test("xmlParserTagValues parses with tag value parsing", () => {
    const doc = xmlParserTagValues.parse("<root><value>123</value></root>") as Record<string, unknown>;
    expect(doc).toBeDefined();
  });
});
