/**
 * Node config.xml builder.
 * Ports legacy/cb/api/xml_builder.py build_permanent_node_xml (SSH vs JNLP launcher).
 */

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build a Permanent Agent (<slave>) config.xml.
 * SSHLauncher when `host` is given, otherwise JNLPLauncher — mirrors the Python builder.
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
    ? [
        '  <launcher class="hudson.plugins.sshslaves.SSHLauncher" plugin="ssh-slaves">',
        `    <host>${escape(host)}</host>`,
        `    <port>${port}</port>`,
        `    <credentialsId>${escape(credentialsId)}</credentialsId>`,
        '    <sshHostKeyVerificationStrategy class="hudson.plugins.sshslaves.verifiers.NonVerifyingKeyVerificationStrategy"/>',
        "  </launcher>",
      ].join("\n")
    : '  <launcher class="hudson.slaves.JNLPLauncher"/>';

  return [
    "<?xml version='1.1' encoding='UTF-8'?>",
    "<slave>",
    `  <name>${escape(name)}</name>`,
    `  <description>${escape(desc)}</description>`,
    `  <remoteFS>${escape(remoteDir)}</remoteFS>`,
    `  <numExecutors>${numExecutors}</numExecutors>`,
    "  <mode>NORMAL</mode>",
    '  <retentionStrategy class="hudson.slaves.RetentionStrategy$Always"/>',
    launcher,
    `  <label>${escape(labels)}</label>`,
    "  <nodeProperties/>",
    "</slave>",
  ].join("\n");
}
