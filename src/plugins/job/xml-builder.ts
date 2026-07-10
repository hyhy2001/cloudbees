/**
 * Freestyle/Folder job config.xml builders — the job-specific XML.
 *
 * Hand-builds indented XML (2-space) with the prolog
 * `<?xml version='1.1' encoding='UTF-8'?>` to match Python ET.indent() output.
 *
 * Email-ext and TimerTrigger XML are NOT here — they live in domain/email and
 * domain/schedule (shared, leaf, unit-tested). This file composes them into a
 * `<project>`.
 */

import { escapeXml, xmlParser } from "../../domain/xml";
import { buildEmailPublisherBlock } from "../../domain/email";
import { buildTimerTriggerBlock } from "../../domain/schedule";
import type { StringParamDef, PipelineXmlOpts } from "./types";

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
    lines.push(`${i4}  <name>${escapeXml(p.name)}</name>`);
    lines.push(`${i4}  <description>${escapeXml(p.description ?? "")}</description>`);
    lines.push(`${i4}  <defaultValue>${escapeXml(p.defaultValue ?? "")}</defaultValue>`);
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
  concurrent?: boolean;
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
    concurrent = false,
  } = opts;

  // Quote chdir so paths with spaces survive the shell (e.g. "cd /my dir && cmd").
  const finalCmd = chdir ? `cd "${chdir}" && ${shellCmd}` : shellCmd;
  const canRoam = node ? "false" : "true";

  const lines: string[] = [
    "<?xml version='1.1' encoding='UTF-8'?>",
    "<project>",
    `  <description>${escapeXml(desc)}</description>`,
    "  <keepDependencies>false</keepDependencies>",
    buildParametersProperty(params, "  "),
    '  <scm class="hudson.scm.NullSCM"/>',
    `  <canRoam>${canRoam}</canRoam>`,
  ];

  if (node) {
    lines.push(`  <assignedNode>${escapeXml(node)}</assignedNode>`);
  }

  lines.push("  <disabled>false</disabled>");
  lines.push("  <triggers>");

  const timer = buildTimerTriggerBlock(schedule, "    ");
  if (timer) lines.push(timer);

  lines.push("  </triggers>");
  lines.push(`  <concurrentBuild>${concurrent ? "true" : "false"}</concurrentBuild>`);
  lines.push("  <builders>");
  lines.push("    <hudson.tasks.Shell>");
  lines.push(`      <command>${escapeXml(finalCmd)}</command>`);
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
    `  <description>${escapeXml(desc)}</description>`,
    "  <views/>",
    "  <primaryView>All</primaryView>",
    "  <healthMetrics/>",
    "</com.cloudbees.hudson.plugins.folder.Folder>",
  ];
  return lines.join("\n");
}

/**
 * Build a Pipeline (WorkflowJob) config.xml.
 * Uses CpsFlowDefinition (inline script) with optional publishers and triggers.
 */
export function buildPipelineXml(opts: PipelineXmlOpts): string {
  const {
    desc = "",
    script = "pipeline { agent any; stages { stage('Build') { steps { echo 'hello' } } } }",
    schedule = null,
    email = null,
    emailCond = "failed",
    emailKeywords = null,
    emailRegex = null,
    params = null,
  } = opts;

  const lines: string[] = [
    "<?xml version='1.1' encoding='UTF-8'?>",
    '<flow-definition plugin="workflow-job@2.40">',
    `  <description>${escapeXml(desc)}</description>`,
    "  <keepDependencies>false</keepDependencies>",
    buildParametersProperty(params, "  "),
    `  <definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition" plugin="workflow-cps@2.90">`,
    `    <script>${escapeXml(script)}</script>`,
    "    <sandbox>true</sandbox>",
    "  </definition>",
    "  <triggers>",
  ];

  const timer = buildTimerTriggerBlock(schedule, "    ");
  if (timer) lines.push(timer);

  lines.push("  </triggers>");
  lines.push("  <publishers>");

  if (email) {
    lines.push(buildEmailPublisherBlock(email, emailCond, emailKeywords, emailRegex, "    "));
  }

  lines.push("  </publishers>");
  lines.push("  <disabled>false</disabled>");
  lines.push("</flow-definition>");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// XML patch helpers for updateJobFreestyle (parse + mutate config.xml)
// These use fast-xml-parser for reading and hand-built string replacement
// for writing back, since the update flow re-posts raw XML.
// ---------------------------------------------------------------------------

/** Parse config.xml and extract the presendScript text value. */
function extractPresendScriptFromXml(configXml: string): string | null {
  const doc = xmlParser.parse(configXml) as Record<string, unknown>;
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
