/**
 * Shared XML escaping for Jenkins config.xml building.
 *
 * A leaf module: domain/ never imports core/ or plugins/, so both can depend on
 * it. Escapes the five XML predefined entities for use in attribute values and
 * text content. Mirrors the per-plugin `escape()`/`escapeXml()` helpers this
 * replaces (job + node builders had their own copies).
 */

/** Escape the five XML predefined entities (attr + text content). */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
