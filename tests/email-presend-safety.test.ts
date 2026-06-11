/**
 * Safety/correctness guards for the email presend Groovy script.
 *
 * These lock in two fixes:
 *  1. groovyDoubleQuoted escapes `$` so a keyword/regex containing a dollar sign
 *     (e.g. the regex end-anchor `$`, or a literal `${cancel}`) cannot be
 *     interpolated as a Groovy GString at runtime (injection / MissingProperty).
 *  2. An invalid regex must NOT `cancel = true` inside its catch block — a bad
 *     regex should only disable the regex filter, leaving keyword matching (and
 *     thus email delivery) intact.
 */

import { describe, test, expect } from "bun:test";
import {
  groovyDoubleQuoted,
  buildEmailFilterPresendScript,
} from "../src/plugins/job/xml-builder";

describe("groovyDoubleQuoted", () => {
  test("escapes backslash, double-quote, and dollar", () => {
    expect(groovyDoubleQuoted('a"b')).toBe('a\\"b');
    expect(groovyDoubleQuoted("a\\b")).toBe("a\\\\b");
    expect(groovyDoubleQuoted("end$")).toBe("end\\$");
    expect(groovyDoubleQuoted("${cancel}")).toBe("\\${cancel}");
  });

  test("a dollar keyword never appears unescaped in the generated script", () => {
    const script = buildEmailFilterPresendScript(["${cancel = true}"], null);
    // Check the executable Groovy line, not the leading `// BEE_EMAIL_FILTER_META:`
    // JSON comment (which legitimately carries the raw keyword and is inert).
    const kwLine = script
      .split("\n")
      .find((l) => l.startsWith("def _bee_keywords ="))!;
    expect(kwLine).not.toContain('"${cancel = true}"');
    expect(kwLine).toContain('"\\${cancel = true}"');
  });
});

describe("invalid regex does not cancel all email", () => {
  test("regex catch block sets _bee_regex_match=false, not cancel=true", () => {
    const script = buildEmailFilterPresendScript(["CRITICAL"], "([unterminated");
    const catchIdx = script.indexOf("_bee_regex_error");
    expect(catchIdx).toBeGreaterThan(-1);
    // From the catch handler to the end of the regex block, there must be no
    // `cancel = true` — only the keyword/no-match path below may cancel.
    const afterCatch = script.slice(catchIdx, script.indexOf("_bee_has_keywords"));
    expect(afterCatch).not.toContain("cancel = true");
    expect(afterCatch).toContain("_bee_regex_match = false");
  });
});
