/**
 * Job String Parameter builder tests (I2) — no network.
 *
 * Covers buildParametersProperty (empty → self-closing, one/many params, escaping)
 * and that buildFreestyleXml swaps the <properties> block when params are given.
 */

import { describe, test, expect } from "bun:test";
import { buildParametersProperty, buildFreestyleXml } from "../src/plugins/job/xml-builder";
import type { StringParamDef } from "../src/plugins/job/types";

describe("buildParametersProperty", () => {
  test("empty / null → self-closing <properties/>", () => {
    expect(buildParametersProperty([])).toBe("  <properties/>");
    expect(buildParametersProperty(null)).toBe("  <properties/>");
    expect(buildParametersProperty(undefined)).toBe("  <properties/>");
  });

  test("one param emits a StringParameterDefinition with name/desc/default", () => {
    const xml = buildParametersProperty([
      { name: "BRANCH", defaultValue: "main", description: "Git branch" },
    ]);
    expect(xml).toContain("<hudson.model.ParametersDefinitionProperty>");
    expect(xml).toContain("<hudson.model.StringParameterDefinition>");
    expect(xml).toContain("<name>BRANCH</name>");
    expect(xml).toContain("<defaultValue>main</defaultValue>");
    expect(xml).toContain("<description>Git branch</description>");
    expect(xml).toContain("</properties>");
  });

  test("multiple params each get their own definition", () => {
    const params: StringParamDef[] = [
      { name: "A", defaultValue: "1" },
      { name: "B", defaultValue: "2" },
      { name: "C" },
    ];
    const xml = buildParametersProperty(params);
    const count = (xml.match(/<hudson\.model\.StringParameterDefinition>/g) ?? []).length;
    expect(count).toBe(3);
    expect(xml).toContain("<name>A</name>");
    expect(xml).toContain("<name>C</name>");
    // Missing default/description fall back to empty elements.
    expect(xml).toContain("<defaultValue></defaultValue>");
  });

  test("escapes XML-special chars in name/default", () => {
    const xml = buildParametersProperty([
      { name: "A&B", defaultValue: "<x>" },
    ]);
    expect(xml).toContain("<name>A&amp;B</name>");
    expect(xml).toContain("<defaultValue>&lt;x&gt;</defaultValue>");
  });
});

describe("buildFreestyleXml with params", () => {
  test("no params → keeps self-closing <properties/>", () => {
    const xml = buildFreestyleXml({ shellCmd: "echo hi" });
    expect(xml).toContain("<properties/>");
    expect(xml).not.toContain("ParametersDefinitionProperty");
  });

  test("with params → injects the ParametersDefinitionProperty block", () => {
    const xml = buildFreestyleXml({
      shellCmd: "echo hi",
      params: [{ name: "BRANCH", defaultValue: "main" }],
    });
    expect(xml).not.toMatch(/<properties\/>/);
    expect(xml).toContain("<hudson.model.ParametersDefinitionProperty>");
    expect(xml).toContain("<name>BRANCH</name>");
    // The job body still renders.
    expect(xml).toContain("<command>echo hi</command>");
  });
});
