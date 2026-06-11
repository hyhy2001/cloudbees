/**
 * Job XML builders.
 * Ports legacy/cb/api/xml_builder.py — job-related builders only.
 *
 * Hand-builds indented XML (2-space) with the prolog
 * `<?xml version='1.1' encoding='UTF-8'?>` to match Python ET.indent() output.
 */

import { XMLParser } from "fast-xml-parser";
import type { EmailFilterMeta, StringParamDef } from "./types";

const EMAIL_FILTER_META_PREFIX = "BEE_EMAIL_FILTER_META:";
const EMAIL_FILTER_VERSION = 1;

/** Escape XML special chars (attr + text content). */
function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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

/**
 * Strip, dedupe-empty, return trimmed keywords.
 * Mirrors Python _normalize_keywords().
 */
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

/**
 * Build the email-ext presendScript that cancels email when the log doesn't match.
 * Mirrors Python build_email_filter_presend_script() line-for-line.
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

  // JSON.stringify with no spaces = Python separators=(',',':')
  const metaLine = `// ${EMAIL_FILTER_META_PREFIX}${JSON.stringify(meta)}`;

  const keywordList = keywords.map((k) => `"${groovyDoubleQuoted(k)}"`).join(", ");
  const regexLiteral = regex === null ? "null" : `"${groovyDoubleQuoted(regex)}"`;
  const caseLiteral = caseSensitive ? "true" : "false";

  const lines = [
    metaLine,
    "def _bee_raw = ''",
    "def _bee_log_readable = false",
    "try {",
    "  def _bee_target = null",
    "  if (binding?.hasVariable('run')) { _bee_target = run }",
    "  else if (binding?.hasVariable('build')) { _bee_target = build }",
    "  def _bee_lines = _bee_target?.getLog(100000)",
    "  if (_bee_lines != null) {",
    "    _bee_raw = _bee_lines.join('\\n') ?: ''",
    "    _bee_log_readable = true",
    "  }",
    "} catch (Throwable _bee_ignore) {",
    "}",
    "if (!_bee_log_readable) {",
    "  try {",
    "    def _bee_target2 = null",
    "    if (binding?.hasVariable('run')) { _bee_target2 = run }",
    "    else if (binding?.hasVariable('build')) { _bee_target2 = build }",
    "    _bee_raw = _bee_target2?.logFile?.text ?: ''",
    "    _bee_log_readable = (_bee_raw != '')",
    "  } catch (Throwable _bee_ignore2) {",
    "    _bee_raw = ''",
    "  }",
    "}",
    "if (!_bee_log_readable) {",
    "  logger.println('[bee] cannot read build log in sandbox; skip content filter')",
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

/**
 * Parse bee filter metadata from a presendScript string.
 * Mirrors Python parse_email_filter_metadata().
 */
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

// ---------------------------------------------------------------------------
// Email trigger builder helper (inner block used by injectEmailPublisher)
// ---------------------------------------------------------------------------

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
 * Build the ExtendedEmailPublisher XML block and return as indented lines.
 * Used by both buildFreestyleXml and updateJobFreestyle (XML patch).
 * Mirrors Python inject_email_publisher().
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
  if (emailCond === "failed" || emailCond === "always") {
    triggerLines.push(
      emailTriggerBlock(
        "hudson.plugins.emailext.plugins.trigger.FailureTrigger",
        i2 + "  ",
      ),
    );
  }
  if (emailCond === "success" || emailCond === "always") {
    triggerLines.push(
      emailTriggerBlock(
        "hudson.plugins.emailext.plugins.trigger.SuccessTrigger",
        i2 + "  ",
      ),
    );
  }

  const presend = buildEmailFilterPresendScript(emailKeywords, emailRegex, false);
  // Escape presend script for XML text content
  const presendEscaped = escape(presend);

  const lines = [
    `${i}<hudson.plugins.emailext.ExtendedEmailPublisher plugin="email-ext">`,
    `${i2}<recipientList>${escape(email)}</recipientList>`,
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

/**
 * Build the `<properties>` block for a job. When `params` is empty, returns the
 * self-closing `<properties/>` (matches the legacy default). Otherwise emits a
 * `ParametersDefinitionProperty` holding one `StringParameterDefinition` per
 * param. `indent` is the leading whitespace for the `<properties>` tag.
 */
export function buildParametersProperty(
  params: StringParamDef[] | null | undefined,
  indent = "  ",
): string {
  if (!params || params.length === 0) return `${indent}<properties/>`;

  const i2 = `${indent}  `;
  const i3 = `${indent}    `;
  const i4 = `${indent}      `;

  const lines: string[] = [
    `${indent}<properties>`,
    `${i2}<hudson.model.ParametersDefinitionProperty>`,
    `${i3}<parameterDefinitions>`,
  ];

  for (const p of params) {
    lines.push(`${i4}<hudson.model.StringParameterDefinition>`);
    lines.push(`${i4}  <name>${escape(p.name)}</name>`);
    lines.push(`${i4}  <description>${escape(p.description ?? "")}</description>`);
    lines.push(`${i4}  <defaultValue>${escape(p.defaultValue ?? "")}</defaultValue>`);
    lines.push(`${i4}  <trim>false</trim>`);
    lines.push(`${i4}</hudson.model.StringParameterDefinition>`);
  }

  lines.push(`${i3}</parameterDefinitions>`);
  lines.push(`${i2}</hudson.model.ParametersDefinitionProperty>`);
  lines.push(`${indent}</properties>`);
  return lines.join("\n");
}

/**
 * Build a Freestyle project config.xml.
 * Mirrors Python build_freestyle_xml() exactly.
 */
export function buildFreestyleXml(opts: {
  desc?: string;
  shellCmd?: string;
  node?: string | null;
  chdir?: string | null;
  schedule?: string | null;
  email?: string | null;
  emailCond?: string;
  emailKeywords?: string[] | null;
  emailRegex?: string | null;
  params?: StringParamDef[] | null;
}): string {
  const {
    desc = "",
    shellCmd = "echo hello",
    node = null,
    chdir = null,
    schedule = null,
    email = null,
    emailCond = "failed",
    emailKeywords = null,
    emailRegex = null,
    params = null,
  } = opts;

  const finalCmd = chdir ? `cd ${chdir} && ${shellCmd}` : shellCmd;
  const canRoam = node ? "false" : "true";

  const lines: string[] = [
    "<?xml version='1.1' encoding='UTF-8'?>",
    "<project>",
    `  <description>${escape(desc)}</description>`,
    "  <keepDependencies>false</keepDependencies>",
    buildParametersProperty(params, "  "),
    '  <scm class="hudson.scm.NullSCM"/>',
    `  <canRoam>${canRoam}</canRoam>`,
  ];

  if (node) {
    lines.push(`  <assignedNode>${escape(node)}</assignedNode>`);
  }

  lines.push("  <disabled>false</disabled>");
  lines.push("  <triggers>");

  if (schedule) {
    lines.push("    <hudson.triggers.TimerTrigger>");
    lines.push(`      <spec>${escape(schedule)}</spec>`);
    lines.push("    </hudson.triggers.TimerTrigger>");
  }

  lines.push("  </triggers>");
  lines.push("  <builders>");
  lines.push("    <hudson.tasks.Shell>");
  lines.push(`      <command>${escape(finalCmd)}</command>`);
  lines.push("    </hudson.tasks.Shell>");
  lines.push("  </builders>");
  lines.push("  <publishers>");

  if (email) {
    lines.push(buildEmailPublisherBlock(email, emailCond, emailKeywords, emailRegex, "    "));
  }

  lines.push("  </publishers>");
  lines.push("  <buildWrappers/>");
  lines.push("</project>");

  return lines.join("\n");
}

/**
 * Build a CloudBees Folder config.xml.
 * Mirrors Python build_folder_xml().
 */
export function buildFolderXml(desc = ""): string {
  const lines = [
    "<?xml version='1.1' encoding='UTF-8'?>",
    '<com.cloudbees.hudson.plugins.folder.Folder plugin="cloudbees-folder">',
    `  <description>${escape(desc)}</description>`,
    "  <views/>",
    "  <primaryView>All</primaryView>",
    "  <healthMetrics/>",
    "</com.cloudbees.hudson.plugins.folder.Folder>",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// XML patch helpers for updateJobFreestyle (parse + mutate config.xml)
// These use fast-xml-parser for reading and hand-built string replacement
// for writing back, since the update flow re-posts raw XML.
// ---------------------------------------------------------------------------

/** Parse config.xml and extract the presendScript text value. */
export function extractPresendScriptFromXml(configXml: string): string | null {
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
  const doc = parser.parse(configXml) as Record<string, unknown>;
  // Walk: project > publishers > ExtendedEmailPublisher > presendScript
  const project = doc["project"] as Record<string, unknown> | undefined;
  if (!project) return null;
  const publishers = project["publishers"] as Record<string, unknown> | undefined;
  if (!publishers) return null;
  const ext = publishers[
    "hudson.plugins.emailext.ExtendedEmailPublisher"
  ] as Record<string, unknown> | undefined;
  if (!ext) return null;
  const ps = ext["presendScript"];
  return typeof ps === "string" ? ps : null;
}
