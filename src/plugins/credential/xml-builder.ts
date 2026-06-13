/**
 * Credential XML builders.
 * Ports legacy/cb/api/xml_builder.py — build_username_password_cred_xml only.
 */

import { escapeXml } from "../../domain/xml";

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
  const lines = [
    "<?xml version='1.1' encoding='UTF-8'?>",
    "<org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl>",
    `  <scope>${escapeXml(scope)}</scope>`,
    `  <id>${escapeXml(credId)}</id>`,
    `  <description>${escapeXml(desc)}</description>`,
    `  <secret>${escapeXml(secret)}</secret>`,
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
  const lines = [
    "<?xml version='1.1' encoding='UTF-8'?>",
    "<com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>",
    `  <scope>${escapeXml(scope)}</scope>`,
    `  <id>${escapeXml(credId)}</id>`,
    `  <description>${escapeXml(desc)}</description>`,
    `  <username>${escapeXml(username)}</username>`,
    `  <password>${escapeXml(password)}</password>`,
    "</com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>",
  ];

  return lines.join("\n");
}
