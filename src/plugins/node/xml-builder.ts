/**
 * Node config.xml builder.
 * Ports legacy/cb/api/xml_builder.py build_permanent_node_xml (SSH vs JNLP launcher),
 * extended with editable launcher + retention (availability) subtrees so updateNode
 * can swap them in a fetched config.xml.
 */

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Default Java path for SSH launchers (mirrors service DEFAULT_JAVA_PATH). */
export const DEFAULT_JAVA_PATH = "/usr/local/java/openjdk-19.0.2-7/bin/java";

export type LauncherType = "ssh" | "jnlp";
export type Availability = "always" | "demand";

export interface LauncherOpts {
  type: LauncherType;
  host?: string;
  port?: number;
  credentialsId?: string;
  javaPath?: string;
}

export interface RetentionOpts {
  availability: Availability;
  /** Minutes the queue must have demand before bringing the agent online (Demand only). */
  inDemandDelay?: number;
  /** Minutes the agent must be idle before taking it offline (Demand only). */
  idleDelay?: number;
}

/**
 * Build the `<launcher>` subtree. SSH carries host/port/credentialsId/javaPath;
 * JNLP is the richer block with workDirSettings (matches the legacy Python builder).
 * `indent` is the leading whitespace for the opening tag (children get +2).
 */
export function buildLauncherXml(opts: LauncherOpts, indent = "  "): string {
  const c = `${indent}  `;
  if (opts.type === "ssh") {
    const { host = "", port = 22, credentialsId = "", javaPath = DEFAULT_JAVA_PATH } = opts;
    return [
      `${indent}<launcher class="hudson.plugins.sshslaves.SSHLauncher" plugin="ssh-slaves">`,
      `${c}<host>${escape(host)}</host>`,
      `${c}<port>${port}</port>`,
      `${c}<credentialsId>${escape(credentialsId)}</credentialsId>`,
      `${c}<javaPath>${escape(javaPath)}</javaPath>`,
      `${c}<sshHostKeyVerificationStrategy class="hudson.plugins.sshslaves.verifiers.NonVerifyingKeyVerificationStrategy"/>`,
      `${indent}</launcher>`,
    ].join("\n");
  }
  // JNLP — richer block with workDirSettings (legacy parity).
  return [
    `${indent}<launcher class="hudson.slaves.JNLPLauncher">`,
    `${c}<workDirSettings>`,
    `${c}  <disabled>false</disabled>`,
    `${c}  <internalDir>remoting</internalDir>`,
    `${c}  <failIfWorkDirIsMissing>false</failIfWorkDirIsMissing>`,
    `${c}</workDirSettings>`,
    `${indent}</launcher>`,
  ].join("\n");
}

/**
 * Build the `<retentionStrategy>` subtree. `always` is self-closing;
 * `demand` carries inDemandDelay + idleDelay child elements.
 */
export function buildRetentionXml(opts: RetentionOpts, indent = "  "): string {
  if (opts.availability === "demand") {
    const { inDemandDelay = 0, idleDelay = 1 } = opts;
    const c = `${indent}  `;
    return [
      `${indent}<retentionStrategy class="hudson.slaves.RetentionStrategy$Demand">`,
      `${c}<inDemandDelay>${inDemandDelay}</inDemandDelay>`,
      `${c}<idleDelay>${idleDelay}</idleDelay>`,
      `${indent}</retentionStrategy>`,
    ].join("\n");
  }
  return `${indent}<retentionStrategy class="hudson.slaves.RetentionStrategy$Always"/>`;
}

/**
 * Build a Permanent Agent (<slave>) config.xml.
 * SSHLauncher when `host` is given, otherwise JNLPLauncher.
 */
export function buildPermanentNodeXml(
  name: string,
  remoteDir: string,
  numExecutors = 1,
  labels = "",
  desc = "",
  host = "",
  port = 22,
  credentialsId = "",
): string {
  const launcher = host
    ? buildLauncherXml({ type: "ssh", host, port, credentialsId })
    : buildLauncherXml({ type: "jnlp" });

  return [
    "<?xml version='1.1' encoding='UTF-8'?>",
    "<slave>",
    `  <name>${escape(name)}</name>`,
    `  <description>${escape(desc)}</description>`,
    `  <remoteFS>${escape(remoteDir)}</remoteFS>`,
    `  <numExecutors>${numExecutors}</numExecutors>`,
    "  <mode>NORMAL</mode>",
    buildRetentionXml({ availability: "always" }),
    launcher,
    `  <label>${escape(labels)}</label>`,
    "  <nodeProperties/>",
    "</slave>",
  ].join("\n");
}
