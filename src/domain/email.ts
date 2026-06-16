/**
 * Email-ext domain logic — the Jenkins email-ext "ExtendedEmailPublisher" config
 * block plus the anti-spam presend Groovy script that cancels a build's email
 * when the log doesn't match the user's keywords/regex.
 *
 * A leaf module (domain/ never imports core/ or plugins/), so the job plugin and
 * any future consumer (pipelines, multibranch) share one copy. This is also the
 * blast radius of the email-correctness/security fixes — keeping it isolated and
 * unit-tested is the point of the split.
 *
 * Filter metadata round-trips through a marker comment line in the presendScript
 * (`// BEE_EMAIL_FILTER_META:{json}`) so an existing job's filter can be read back
 * for editing — Jenkins gives us the script text, not structured fields.
 */

import { escapeXml } from "./xml";
import { ValidationError } from "../core/api/errors";

const EMAIL_FILTER_META_PREFIX = "BEE_EMAIL_FILTER_META:";
const EMAIL_FILTER_VERSION = 1;

/** Parsed email-filter metadata stored in the presendScript marker line. */
export interface EmailFilterMeta {
  version: number;
  keywords: string[];
  regex: string | null;
  case_sensitive: boolean;
}

/**
 * Escape a string for use inside a Groovy double-quoted string literal.
 *
 * Groovy double-quoted strings are GStrings: `$var` / `${expr}` interpolate at
 * runtime. A user keyword/regex containing `$` (e.g. the regex end-anchor `$`,
 * or a literal `"${cancel}"`) would otherwise be interpolated — at best throwing
 * MissingPropertyException (which breaks the presend script and disrupts email),
 * at worst executing an assignment. We escape `$` → `\$` so it stays a literal
 * dollar character in the resulting string value (Groovy `"\$"` evaluates to `$`).
 */
export function groovyDoubleQuoted(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$");
}

/** Strip, drop-empty, return trimmed keywords. */
export function normalizeKeywords(keywords: string[] | null | undefined): string[] {
  if (!keywords || keywords.length === 0) return [];
  const out: string[] = [];
  for (const kw of keywords) {
    if (kw == null) continue;
    const v = String(kw).trim();
    if (v) out.push(v);
  }
  return out;
}

/** Trim a regex to a non-empty string, or null. */
export function normalizeRegex(emailRegex: string | null | undefined): string | null {
  if (emailRegex == null) return null;
  const val = String(emailRegex).trim();
  return val || null;
}

/**
 * Validate a regex client-side using the JS engine. Note: Jenkins evaluates it
 * with Java's engine, so a pattern valid here can still throw there — the presend
 * script handles that at runtime by disabling only the regex filter (never
 * cancelling mail). This catches the obvious typos early with a friendly error.
 */
export function validateRegex(emailRegex: string | null | undefined): void {
  if (!emailRegex) return;
  try {
    new RegExp(emailRegex);
  } catch (e) {
    throw new ValidationError(`Invalid --email-regex: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Build the email-ext presendScript that cancels email when the build log
 * doesn't contain any of the keywords / match the regex.
 *
 * Returns the email-ext default (`$DEFAULT_PRESEND_SCRIPT`) when there is no
 * filter, so an unfiltered job keeps stock behaviour. Otherwise emits Groovy
 * that: reads the log (two fallbacks for sandbox), keyword-scans, regex-matches
 * (a bad regex disables ONLY the regex filter, it never cancels), and cancels
 * the email if nothing matched. A metadata comment line carries the filter so it
 * round-trips through parseEmailFilterMetadata.
 */
export function buildEmailFilterPresendScript(
  emailKeywords?: string[] | null,
  emailRegex?: string | null,
  caseSensitive = false,
): string {
  const keywords = normalizeKeywords(emailKeywords);
  const regex = (emailRegex ?? "").trim() || null;

  if (keywords.length === 0 && !regex) {
    return "$DEFAULT_PRESEND_SCRIPT";
  }

  const meta: EmailFilterMeta = {
    version: EMAIL_FILTER_VERSION,
    keywords,
    regex,
    case_sensitive: Boolean(caseSensitive),
  };

  const metaLine = `// ${EMAIL_FILTER_META_PREFIX}${JSON.stringify(meta)}`;

  const keywordList = keywords.map((k) => `"${groovyDoubleQuoted(k)}"`).join(", ");
  const regexLiteral = regex === null ? "null" : `"${groovyDoubleQuoted(regex)}"`;
  const caseLiteral = caseSensitive ? "true" : "false";

  const lines = [
    metaLine,
    "def _bee_raw = ''",
    "def _bee_log_readable = false",
    "try {",
    "  if (binding?.hasVariable('build') && build != null) {",
    "    _bee_raw = build.getLog(Integer.MAX_VALUE).join('\\n') ?: ''",
    "    _bee_log_readable = true",
    "  }",
    "} catch (Throwable _bee_ignore) {",
    "  logger.println('[bee] log fetch error: ' + _bee_ignore.message)",
    "}",
    "if (!_bee_log_readable) {",
    "  logger.println('[bee] cannot read build log; skip content filter')",
    "}",
    `def _bee_case_sensitive = ${caseLiteral}`,
    `def _bee_keywords = [${keywordList}]`,
    `def _bee_regex = ${regexLiteral}`,
    "def _bee_source = _bee_raw",
    "if (!_bee_case_sensitive) {",
    "  _bee_source = _bee_raw.toLowerCase(java.util.Locale.ROOT)",
    "}",
    "def _bee_kw_match = false",
    "for (kw in _bee_keywords) {",
    "  if (!kw) { continue }",
    "  def _needle = _bee_case_sensitive ? kw : kw.toLowerCase(java.util.Locale.ROOT)",
    "  if (_bee_source.contains(_needle)) {",
    "    _bee_kw_match = true",
    "    break",
    "  }",
    "}",
    "def _bee_regex_match = false",
    "if (_bee_regex) {",
    "  try {",
    "    def _bee_regex_expr = _bee_case_sensitive ? '(?s).*(' + _bee_regex + ').*' : '(?is).*(' + _bee_regex + ').*'",
    "    _bee_regex_match = (_bee_raw ==~ _bee_regex_expr)",
    "  } catch (Throwable _bee_regex_error) {",
    "    logger.println('[bee] email regex invalid, ignoring regex filter: ' + _bee_regex_error)",
    "    _bee_regex_match = false",
    "  }",
    "}",
    "def _bee_has_keywords = !_bee_keywords.isEmpty()",
    "def _bee_has_regex = (_bee_regex != null && _bee_regex != '')",
    "def _bee_match = true",
    "if (_bee_log_readable) {",
    "  _bee_match = (_bee_has_keywords && _bee_kw_match) || (_bee_has_regex && _bee_regex_match)",
    "}",
    "if (!_bee_match) {",
    "  logger.println('[bee] cancel email: no keyword/regex match found in build log')",
    "  cancel = true",
    "}",
  ];

  return lines.join("\n");
}

/** Parse bee filter metadata from a presendScript string (null if absent/garbled). */
export function parseEmailFilterMetadata(
  presendScript: string | null | undefined,
): EmailFilterMeta | null {
  if (!presendScript) return null;

  for (const rawLine of presendScript.split("\n")) {
    const line = rawLine.trim();
    const marker = `// ${EMAIL_FILTER_META_PREFIX}`;
    if (!line.startsWith(marker)) continue;
    const payload = line.slice(marker.length).trim();
    if (!payload) return null;
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      return null;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    const obj = data as Record<string, unknown>;
    const keywordsRaw = obj["keywords"];
    const regexRaw = obj["regex"];
    return {
      version: typeof obj["version"] === "number" ? obj["version"] : EMAIL_FILTER_VERSION,
      keywords: normalizeKeywords(Array.isArray(keywordsRaw) ? (keywordsRaw as string[]) : []),
      regex:
        typeof regexRaw === "string" && regexRaw.trim()
          ? regexRaw.trim()
          : null,
      case_sensitive: Boolean(obj["case_sensitive"]),
    };
  }
  return null;
}

/** One configured-trigger block (Failure/Success) nested in the publisher. */
function emailTriggerBlock(tagName: string, indent: string): string {
  const i = indent;
  const i2 = indent + "  ";
  const i3 = indent + "    ";
  const i4 = indent + "      ";
  return [
    `${i}<${tagName}>`,
    `${i2}<email>`,
    `${i3}<subject>$PROJECT_DEFAULT_SUBJECT</subject>`,
    `${i3}<body>$PROJECT_DEFAULT_CONTENT</body>`,
    `${i3}<recipientList></recipientList>`,
    `${i3}<recipientProviders>`,
    `${i4}<hudson.plugins.emailext.plugins.recipients.ListRecipientProvider/>`,
    `${i3}</recipientProviders>`,
    `${i3}<attachmentsPattern></attachmentsPattern>`,
    `${i3}<attachBuildLog>false</attachBuildLog>`,
    `${i3}<compressBuildLog>false</compressBuildLog>`,
    `${i3}<replyTo>$PROJECT_DEFAULT_REPLYTO</replyTo>`,
    `${i3}<contentType>project</contentType>`,
    `${i2}</email>`,
    `${i}</${tagName}>`,
  ].join("\n");
}

/**
 * Build the ExtendedEmailPublisher XML block (recipient + triggers + filter
 * presend script). `emailCond` is one of "failed" | "success" | "always" and
 * decides which trigger blocks are emitted.
 */
export function buildEmailPublisherBlock(
  email: string,
  emailCond: string,
  emailKeywords?: string[] | null,
  emailRegex?: string | null,
  baseIndent = "  ",
): string {
  const i = baseIndent;
  const i2 = baseIndent + "  ";

  const triggerLines: string[] = [];
  // "custom" fires on both failure and success — the presend script handles filtering.
  if (emailCond === "failed" || emailCond === "always" || emailCond === "custom") {
    triggerLines.push(
      emailTriggerBlock(
        "hudson.plugins.emailext.plugins.trigger.FailureTrigger",
        i2 + "  ",
      ),
    );
  }
  if (emailCond === "success" || emailCond === "always" || emailCond === "custom") {
    triggerLines.push(
      emailTriggerBlock(
        "hudson.plugins.emailext.plugins.trigger.SuccessTrigger",
        i2 + "  ",
      ),
    );
  }

  const presend = buildEmailFilterPresendScript(emailKeywords, emailRegex, false);
  const presendEscaped = escapeXml(presend);

  const lines = [
    `${i}<hudson.plugins.emailext.ExtendedEmailPublisher plugin="email-ext">`,
    `${i2}<recipientList>${escapeXml(email)}</recipientList>`,
    `${i2}<configuredTriggers>`,
    ...triggerLines,
    `${i2}</configuredTriggers>`,
    `${i2}<contentType>default</contentType>`,
    `${i2}<defaultSubject>$DEFAULT_SUBJECT</defaultSubject>`,
    `${i2}<defaultContent>$DEFAULT_CONTENT</defaultContent>`,
    `${i2}<attachmentsPattern></attachmentsPattern>`,
    `${i2}<presendScript>${presendEscaped}</presendScript>`,
    `${i2}<postsendScript>$DEFAULT_POSTSEND_SCRIPT</postsendScript>`,
    `${i2}<attachBuildLog>false</attachBuildLog>`,
    `${i2}<compressBuildLog>false</compressBuildLog>`,
    `${i2}<replyTo>$DEFAULT_REPLYTO</replyTo>`,
    `${i2}<from></from>`,
    `${i2}<saveOutput>false</saveOutput>`,
    `${i2}<disabled>false</disabled>`,
    `${i}</hudson.plugins.emailext.ExtendedEmailPublisher>`,
  ];

  return lines.join("\n");
}
