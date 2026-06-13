/**
 * Credential XML builders.
 * Ports legacy/cb/api/xml_builder.py — build_username_password_cred_xml only.
 */

/**
 * Build a SecretText (plain string secret) credential config.xml string.
 * Root element: org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl
 * Child order: scope, id, description, secret
 */
export function buildSecretTextCredXml(
  credId: string,
  secret: string,
  desc = "",
  scope = "GLOBAL",
): string {
  const escape = (s: string): string =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

  const lines = [
    "<?xml version='1.1' encoding='UTF-8'?>",
    "<org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl>",
    `  <scope>${escape(scope)}</scope>`,
    `  <id>${escape(credId)}</id>`,
    `  <description>${escape(desc)}</description>`,
    `  <secret>${escape(secret)}</secret>`,
    "</org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl>",
  ];

  return lines.join("\n");
}

/**
 * Build a UsernamePassword credential config.xml string.
 * Mirrors Python build_username_password_cred_xml() exactly:
 *   - XML 1.1 declaration prolog
 *   - root element: com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl
 *   - child order: scope, id, description, username, password
 *   - 2-space indentation (ET.indent default)
 */
export function buildUsernamePasswordCredXml(
  credId: string,
  username: string,
  password: string,
  desc = "",
  scope = "GLOBAL",
): string {
  // Hand-build the indented XML to match Python's ET.indent(root, space="  ") output exactly.
  const escape = (s: string): string =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

  const lines = [
    "<?xml version='1.1' encoding='UTF-8'?>",
    "<com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>",
    `  <scope>${escape(scope)}</scope>`,
    `  <id>${escape(credId)}</id>`,
    `  <description>${escape(desc)}</description>`,
    `  <username>${escape(username)}</username>`,
    `  <password>${escape(password)}</password>`,
    "</com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>",
  ];

  return lines.join("\n");
}
