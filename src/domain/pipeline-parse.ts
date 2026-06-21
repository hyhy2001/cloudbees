/**
 * Pipeline script parsing — Declarative Pipeline parameter/agent extraction.
 * Uses regex, not a full Groovy parser. Good enough for well-formed Declarative
 * syntax.
 */

import type { StringParamDef } from "../plugins/job/types";

/**
 * Parse `parameters {}` block from a Declarative Pipeline script.
 * Supports: string, choice, booleanParam, text, password.
 */
export function parseParametersFromScript(script: string): StringParamDef[] {
  const params: StringParamDef[] = [];
  const paramsBlock = script.match(/parameters\s*\{([^}]*)\}/s);
  if (!paramsBlock) return params;

  const body = paramsBlock[1]!;

  // string(name: 'X', defaultValue: 'y', description: 'z')
  const stringRe = /string\s*\(\s*name\s*:\s*['"]([^'"]+)['"]([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = stringRe.exec(body)) !== null) {
    const name = m[1]!;
    const rest = m[2] ?? "";
    const defaultValue = rest.match(/defaultValue\s*:\s*['"]([^'"]*)['"]/)?.[1] ?? "";
    const description = rest.match(/description\s*:\s*['"]([^'"]*)['"]/)?.[1] ?? "";
    params.push({ name, defaultValue, description });
  }

  // booleanParam(name: 'X', defaultValue: true)
  const boolRe = /booleanParam\s*\(\s*name\s*:\s*['"]([^'"]+)['"]([^)]*)\)/g;
  while ((m = boolRe.exec(body)) !== null) {
    const name = m[1]!;
    const rest = m[2] ?? "";
    const defaultMatch = rest.match(/defaultValue\s*:\s*(true|false)/);
    const defaultValue = defaultMatch ? defaultMatch[1]! : "false";
    const description = rest.match(/description\s*:\s*['"]([^'"]*)['"]/)?.[1] ?? "";
    params.push({ name, defaultValue, description });
  }

  // choice(name: 'X', choices: [...])
  const choiceRe = /choice\s*\(\s*name\s*:\s*['"]([^'"]+)['"]([^)]*)\)/g;
  while ((m = choiceRe.exec(body)) !== null) {
    const name = m[1]!;
    const rest = m[2] ?? "";
    const choicesMatch = rest.match(/choices\s*:\s*\[([^\]]*)\]/);
    const defaultValue = choicesMatch
      ? choicesMatch[1]!.split(",").map((c) => c.trim().replace(/['"]/g, "")).filter(Boolean)[0] ?? ""
      : "";
    const description = rest.match(/description\s*:\s*['"]([^'"]*)['"]/)?.[1] ?? "";
    params.push({ name, defaultValue, description });
  }

  // text(name: 'X', defaultValue: 'y')
  const textRe = /text\s*\(\s*name\s*:\s*['"]([^'"]+)['"]([^)]*)\)/g;
  while ((m = textRe.exec(body)) !== null) {
    const name = m[1]!;
    const rest = m[2] ?? "";
    const defaultValue = rest.match(/defaultValue\s*:\s*['"]([^'"]*)['"]/)?.[1] ?? "";
    const description = rest.match(/description\s*:\s*['"]([^'"]*)['"]/)?.[1] ?? "";
    params.push({ name, defaultValue, description });
  }

  // password(name: 'X', defaultValue: 'y')
  const passRe = /password\s*\(\s*name\s*:\s*['"]([^'"]+)['"]([^)]*)\)/g;
  while ((m = passRe.exec(body)) !== null) {
    const name = m[1]!;
    const rest = m[2] ?? "";
    const defaultValue = rest.match(/defaultValue\s*:\s*['"]([^'"]*)['"]/)?.[1] ?? "";
    const description = rest.match(/description\s*:\s*['"]([^'"]*)['"]/)?.[1] ?? "";
    params.push({ name, defaultValue, description });
  }

  return params;
}

/**
 * Parse agent directive from a Declarative Pipeline script.
 * Returns the label string, "any", "none", or null if not found.
 */
export function parseAgentFromScript(script: string): string | null {
  // agent { label '...' } or agent { label "... }
  const labelRe = /agent\s*\{[^}]*label\s+(['"])([^'"]+)\1[^}]*\}/s;
  const labelMatch = script.match(labelRe);
  if (labelMatch) return labelMatch[2]!;

  // agent any
  const anyRe = /\bagent\s+any\b/;
  if (anyRe.test(script)) return "any";

  // agent none
  const noneRe = /\bagent\s+none\b/;
  if (noneRe.test(script)) return "none";

  return null;
}

/**
 * Inject or replace the agent directive in a pipeline script.
 * If an agent directive exists, replaces it with `agent { label 'nodeLabel' }`.
 * If none exists, injects it after the opening `pipeline {`.
 *
 * Uses brace counting to handle nested braces (e.g. `agent { docker { ... } }`).
 */
export function injectAgent(script: string, nodeLabel: string): string {
  const replacement = `agent { label '${nodeLabel}' }`;

  // Find the start of any agent block/declaration.
  const agentMatch = script.match(/\bagent\s*(?:\{|any|none\b)/);
  if (agentMatch) {
    const start = agentMatch.index!;
    // If it's a block (agent { ... }), find the matching close brace.
    if (script[start + agentMatch[0].length - 1] === "{") {
      let depth = 0;
      let end = start;
      for (; end < script.length; end++) {
        if (script[end] === "{") depth++;
        else if (script[end] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      return script.slice(0, start) + replacement + script.slice(end + 1);
    }
    // Bare `agent any` or `agent none`.
    return script.slice(0, start) + replacement + script.slice(start + agentMatch[0].length - 1);
  }

  // Inject after the first `pipeline {`
  const pipelineRe = /(pipeline\s*\{)/s;
  if (pipelineRe.test(script)) {
    return script.replace(pipelineRe, `$1\n  ${replacement}`);
  }

  return script;
}
