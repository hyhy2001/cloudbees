/**
 * Node / Agent service — list, get, create, copy, delete, toggle offline, update.
 * Ports legacy/cb/services/node_service.py.
 */
import { XMLParser } from "fast-xml-parser";
import type { CloudBeesClient } from "../../core/api/types";
import { NodeDTO, NodeDetailDTO, nodeFromDict, nodeDetailFromDict } from "../../core/dtos/index";

const _NODE_TREE =
  "computer[displayName,offline,numExecutors,assignedLabels[name],description]";

const DEFAULT_JAVA_PATH = "/usr/local/java/openjdk-19.0.2-7/bin/java";

function formEncode(data: Record<string, string>): string {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/** Lists all agents via `/computer/api/json` using the lightweight `_NODE_TREE` projection; results are cached per `baseUrl`. */
export async function listNodes(client: CloudBeesClient): Promise<NodeDTO[]> {
  const data = await client.get<{ computer?: unknown[] }>(
    `/computer/api/json?tree=${_NODE_TREE}`,
    { cacheKey: `nodes.list.${client.baseUrl}` },
  );
  const computers = data?.computer ?? [];
  return computers.map((c) => nodeFromDict(c as Record<string, unknown>));
}

/**
 * Fetches full node detail from `/computer/<name>/api/json`, then best-effort appends
 * the raw `config.xml` (silently omitted if the endpoint returns an error).
 */
export async function getNode(client: CloudBeesClient, name: string): Promise<NodeDetailDTO> {
  const data = await client.get<Record<string, unknown>>(`/computer/${name}/api/json`, {
    cacheKey: `nodes.detail.${name}`,
  });
  const dto = nodeDetailFromDict(data ?? {});
  try {
    dto.configXml = await client.getText(`/computer/${name}/config.xml`);
  } catch {
    // config.xml is best-effort
  }
  return dto;
}

/** Options for creating a permanent (DumbSlave) agent. Omitting `host` selects the JNLP launcher; providing `host` selects SSH. */
export interface CreateNodeOptions {
  name: string;
  remoteDir: string;
  numExecutors?: number;
  labels?: string;
  desc?: string;
  host?: string;
  port?: number;
  credentialsId?: string;
  javaPath?: string;
}

/**
 * Creates a `hudson.slaves.DumbSlave` via `/computer/doCreateItem` (form-encoded POST).
 * Chooses SSH launcher when `opts.host` is set, JNLP launcher otherwise.
 */
export async function createPermanentNode(
  client: CloudBeesClient,
  opts: CreateNodeOptions,
): Promise<void> {
  const {
    name,
    remoteDir,
    numExecutors = 1,
    labels = "",
    desc = "",
    host = "",
    port = 22,
    credentialsId = "",
    javaPath = DEFAULT_JAVA_PATH,
  } = opts;

  const launcher = host
    ? {
        "stapler-class": "hudson.plugins.sshslaves.SSHLauncher",
        $class: "hudson.plugins.sshslaves.SSHLauncher",
        host,
        port,
        credentialsId,
        javaPath,
        sshHostKeyVerificationStrategy: {
          "stapler-class":
            "hudson.plugins.sshslaves.verifiers.NonVerifyingKeyVerificationStrategy",
          $class: "hudson.plugins.sshslaves.verifiers.NonVerifyingKeyVerificationStrategy",
        },
      }
    : {
        "stapler-class": "hudson.slaves.JNLPLauncher",
        $class: "hudson.slaves.JNLPLauncher",
      };

  const jsonPayload = {
    name,
    nodeDescription: desc,
    numExecutors: String(numExecutors),
    remoteFS: remoteDir,
    labelString: labels,
    mode: "NORMAL",
    type: "hudson.slaves.DumbSlave",
    retentionStrategy: {
      "stapler-class": "hudson.slaves.RetentionStrategy$Always",
      $class: "hudson.slaves.RetentionStrategy$Always",
    },
    nodeProperties: { "stapler-class-bag": "true" },
    launcher,
  };

  const body = formEncode({
    name,
    type: "hudson.slaves.DumbSlave",
    json: JSON.stringify(jsonPayload),
  });

  await client.post("/computer/doCreateItem", {
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    invalidate: "nodes.",
  });
}

/** Copies an existing agent config to a new name via `/computer/doCreateItem` with `mode=copy`. */
export async function copyNode(
  client: CloudBeesClient,
  sourceName: string,
  newName: string,
): Promise<void> {
  const body = formEncode({ name: newName, mode: "copy", from: sourceName });
  await client.post("/computer/doCreateItem", {
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    invalidate: "nodes.",
  });
}

/** Permanently removes an agent via `/computer/<name>/doDelete`. Invalidates the `nodes.` cache. */
export async function deleteNode(client: CloudBeesClient, name: string): Promise<void> {
  await client.post(`/computer/${name}/doDelete`, { invalidate: "nodes." });
}

/**
 * Flips the online/offline state of an agent via `/computer/<name>/toggleOffline`.
 * The optional `reason` is passed as `offlineMessage` query param (visible in the Jenkins UI).
 */
export async function toggleOffline(
  client: CloudBeesClient,
  name: string,
  reason = "",
): Promise<void> {
  const qs = `?offlineMessage=${encodeURIComponent(reason)}`;
  await client.post(`/computer/${name}/toggleOffline${qs}`, { invalidate: "nodes." });
}

/** Fields that can be patched on an existing agent. All are optional; only provided fields are written. */
export interface UpdateNodeOptions {
  remoteDir?: string;
  numExecutors?: number;
  labels?: string;
  desc?: string;
}

/**
 * Partial update of node config.xml — only overwrites provided fields.
 * Mirrors the Python ET-based partial update via string-level replacement.
 */
export async function updateNode(
  client: CloudBeesClient,
  name: string,
  opts: UpdateNodeOptions,
): Promise<void> {
  let xml = await client.getText(`/computer/${name}/config.xml`);

  // Validate the document is well-formed before patching.
  new XMLParser({ ignoreAttributes: false }).parse(xml);

  const setElement = (src: string, tag: string, value: string): string => {
    const re = new RegExp(`(<${tag}>)[\\s\\S]*?(</${tag}>)`);
    const escaped = value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    if (re.test(src)) {
      return src.replace(re, `$1${escaped}$2`);
    }
    // Insert before closing </slave> if the element is missing.
    return src.replace(/<\/slave>\s*$/, `  <${tag}>${escaped}</${tag}>\n</slave>`);
  };

  if (opts.desc !== undefined) xml = setElement(xml, "description", opts.desc);
  if (opts.remoteDir !== undefined) xml = setElement(xml, "remoteFS", opts.remoteDir);
  if (opts.numExecutors !== undefined)
    xml = setElement(xml, "numExecutors", String(opts.numExecutors));
  if (opts.labels !== undefined) xml = setElement(xml, "label", opts.labels);

  await client.postXml(`/computer/${name}/config.xml`, xml, { invalidate: "nodes." });
}
