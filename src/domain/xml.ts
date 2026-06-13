/**
 * Shared XML escaping for Jenkins config.xml building.
 *
 * A leaf module: domain/ never imports core/ or plugins/, so both can depend on
 * it. Escapes the five XML predefined entities for use in attribute values and
 * text content. Mirrors the per-plugin `escape()`/`escapeXml()` helpers this
 * replaces (job + node builders had their own copies).
 */

import { XMLParser } from "fast-xml-parser";

/**
 * Escape the five XML predefined entities (attr + text content).
 * Single-pass character scan: one output array, one .join() —
 * avoids 5 intermediate string allocations from chained .replace().
 */
export function escapeXml(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "&") out += "&amp;";
    else if (c === "<") out += "&lt;";
    else if (c === ">") out += "&gt;";
    else if (c === '"') out += "&quot;";
    else if (c === "'") out += "&apos;";
    else out += c;
  }
  return out;
}

/**
 * Module-level XMLParser singletons — constructing a new XMLParser on every
 * parse call pays option-processing overhead each time. Re-use these instead.
 *
 * Two variants because job/service.ts needs parseTagValue:false while
 * node/service.ts needs the default (true).
 */
export const xmlParser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
export const xmlParserTagValues = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
