/**
 * concurrentBuild ("Execute concurrent builds if necessary") round-trips through
 * the freestyle XML builder and the config-summary reader.
 */
import { describe, test, expect } from "bun:test";
import { buildFreestyleXml } from "../src/plugins/job/xml-builder";

describe("freestyle concurrentBuild", () => {
  test("emits <concurrentBuild>true</concurrentBuild> when concurrent=true", () => {
    const xml = buildFreestyleXml({ shellCmd: "echo x", concurrent: true });
    expect(xml).toContain("<concurrentBuild>true</concurrentBuild>");
  });

  test("emits false by default", () => {
    const xml = buildFreestyleXml({ shellCmd: "echo x" });
    expect(xml).toContain("<concurrentBuild>false</concurrentBuild>");
  });

  test("concurrentBuild sits between </triggers> and <builders>", () => {
    const xml = buildFreestyleXml({ shellCmd: "echo x", concurrent: true });
    const t = xml.indexOf("</triggers>");
    const c = xml.indexOf("<concurrentBuild>");
    const b = xml.indexOf("<builders>");
    expect(t).toBeGreaterThan(-1);
    expect(c).toBeGreaterThan(t);
    expect(b).toBeGreaterThan(c);
  });
});
