/**
 * Node / Agent service — list, get, create, copy, delete, toggle offline, update.
 * Ports legacy/cb/services/node_service.py.
 */
import { xmlParser, xmlParserTagValues } from "../../domain/xml";
import type { CloudBeesClient } from "../../core/api/types";
import { NodeDTO, NodeDetailDTO, nodeFromDict, nodeDetailFromDict } from "../../core/dtos/index";
import { NotFoundError } from "../../core/api/errors";
import {
  buildLauncherXml,
  buildRetentionXml,
  DEFAULT_JAVA_PATH,
  type LauncherType,
  type Availability,
} from "./xml-builder";

const _NODE_TREE =
  "computer[displayName,offline,numExecutors,assignedLabels[name],description]";

export { DEFAULT_JAVA_PATH };

/** URL-encode a node name for use in path segments. */
const nodeSeg = (name: string) => encodeURIComponent(name);

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
  const data = await client.get<Record<string, unknown>>(`/computer/${nodeSeg(name)}/api/json`, {
    cacheKey: `nodes.detail.${client.baseUrl}.${name}`,
  });
  const dto = nodeDetailFromDict(data ?? {});
  try {
    dto.configXml = await client.getText(`/computer/${nodeSeg(name)}/config.xml`);
  } catch (err) {
    // config.xml is best-effort — 404 is expected for built-in nodes; other errors are surfaced.
    if (!(err instanceof NotFoundError)) throw err;
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
  /** Retention strategy. Defaults to "always" (Keep this agent online as much as possible). */
  availability?: Availability;
  inDemandDelay?: number;
  idleDelay?: number;
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
    availability = "always",
    inDemandDelay = 0,
    idleDelay = 1,
  } = opts;

  const retentionStrategy =
    availability === "demand"
      ? {
          "stapler-class": "hudson.slaves.RetentionStrategy$Demand",
          $class: "hudson.slaves.RetentionStrategy$Demand",
          inDemandDelay,
          idleDelay,
        }
      : {
          "stapler-class": "hudson.slaves.RetentionStrategy$Always",
          $class: "hudson.slaves.RetentionStrategy$Always",
        };

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
    retentionStrategy,
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
  await client.post(`/computer/${nodeSeg(name)}/doDelete`, { invalidate: "nodes." });
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
  await client.post(`/computer/${nodeSeg(name)}/toggleOffline${qs}`, { invalidate: "nodes." });
}

/** Fields that can be patched on an existing agent. All are optional; only provided fields are written. */
export interface UpdateNodeOptions {
  remoteDir?: string;
  numExecutors?: number;
  labels?: string;
  desc?: string;
  /** When set, the whole `<launcher>` subtree is rebuilt as ssh or jnlp. */
  launcherType?: LauncherType;
  host?: string;
  port?: number;
  credentialsId?: string;
  javaPath?: string;
  /** When set, the whole `<retentionStrategy>` subtree is rebuilt. */
  availability?: Availability;
  inDemandDelay?: number;
  idleDelay?: number;
}

/** Parsed launcher + availability fields read back from a node's config.xml (for edit prefill). */
export interface NodeConfig {
  launcherType: LauncherType;
  host: string;
  port: number;
  credentialsId: string;
  javaPath: string;
  availability: Availability;
  inDemandDelay: number;
  idleDelay: number;
  remoteDir: string;
}

/**
 * Parse the launcher + retention subtrees out of a node config.xml so the edit
 * form can prefill real values. Tolerant of missing elements (returns sensible
 * defaults: jnlp launcher, always-on).
 */
export function parseNodeConfig(xml: string): NodeConfig {
  const doc = xmlParserTagValues.parse(
    xml,
  ) as Record<string, unknown>;
  // Jenkins serializes the root as 'slave', 'hudson.slaves.DumbSlave', or
  // 'agent' (some CloudBees CI builds). Fall through each candidate.
  const slave = (
    doc["slave"] ??
    doc["hudson.slaves.DumbSlave"] ??
    doc["agent"] ??
    {}
  ) as Record<string, unknown>;

  const launcher = (slave["launcher"] ?? {}) as Record<string, unknown>;
  const launcherClass = String(launcher["@_class"] ?? "");
  const launcherType: LauncherType = launcherClass.includes("SSH") ? "ssh" : "jnlp";

  const retention = (slave["retentionStrategy"] ?? {}) as Record<string, unknown>;
  const retentionClass = String(retention["@_class"] ?? "");
  const availability: Availability = retentionClass.includes("Demand") ? "demand" : "always";

  const numOr = (v: unknown, def: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };

  return {
    launcherType,
    host: String(launcher["host"] ?? ""),
    port: numOr(launcher["port"], 22),
    credentialsId: String(launcher["credentialsId"] ?? ""),
    javaPath: String(launcher["javaPath"] ?? ""),
    availability,
    inDemandDelay: numOr(retention["inDemandDelay"], 0),
    idleDelay: numOr(retention["idleDelay"], 1),
    remoteDir: String(slave["remoteFS"] ?? ""),
  };
}

/**
 * Partial update of node config.xml — only overwrites provided fields.
 * Text fields (description/remoteFS/numExecutors/label) are patched in place;
 * `launcherType` and `availability`, when given, swap the whole `<launcher>` /
 * `<retentionStrategy>` subtree (handles both self-closing and child forms).
 */
export async function updateNode(
  client: CloudBeesClient,
  name: string,
  opts: UpdateNodeOptions,
): Promise<void> {
  let xml = await client.getText(`/computer/${nodeSeg(name)}/config.xml`);

  // Validate the document is well-formed before patching.
  xmlParser.parse(xml);

  const setElement = (src: string, tag: string, value: string): string => {
    // Handle both plain <tag> and Jenkins-style <tag attr="..."> serialization.
    const re = new RegExp(`(<${tag}(?:\\s[^>]*)?>)[\\s\\S]*?(</${tag}>)`);
    const escaped = value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    if (re.test(src)) {
      return src.replace(re, `$1${escaped}$2`);
    }
    // Insert before root closing tag (slave / agent / hudson.slaves.DumbSlave).
    const rootCloseRe = /<\/(slave|agent|hudson\.slaves\.DumbSlave)\s*>/;
    if (!rootCloseRe.test(src)) {
      throw new Error(`updateNode: cannot insert <${tag}> — root closing tag not found in config.xml`);
    }
    return src.replace(rootCloseRe, `  <${tag}>${escaped}</${tag}>\n</$1>`);
  };

  // Swap a whole subtree (matches `<tag .../>` and `<tag ...>...</tag>`).
  const swapElement = (src: string, tag: string, block: string): string => {
    const paired = new RegExp(`[ \\t]*<${tag}(\\s[^>]*)?>[\\s\\S]*?</${tag}>`);
    const selfClosing = new RegExp(`[ \\t]*<${tag}(\\s[^>]*)?\\s*/>`);
    if (paired.test(src)) return src.replace(paired, block);
    if (selfClosing.test(src)) return src.replace(selfClosing, block);
    // Insert before root closing tag if subtree is missing.
    const rootCloseRe = /<\/(slave|agent|hudson\.slaves\.DumbSlave)\s*>/;
    if (!rootCloseRe.test(src)) {
      throw new Error(`updateNode: cannot insert <${tag}> — root closing tag not found in config.xml`);
    }
    return src.replace(rootCloseRe, `${block}\n</$1>`);
  };

  if (opts.desc !== undefined) xml = setElement(xml, "description", opts.desc);
  if (opts.remoteDir !== undefined) xml = setElement(xml, "remoteFS", opts.remoteDir);
  if (opts.numExecutors !== undefined)
    xml = setElement(xml, "numExecutors", String(opts.numExecutors));
  if (opts.labels !== undefined) xml = setElement(xml, "label", opts.labels);

  // Launcher + retention are whole-subtree swaps, so a partial update must merge
  // onto the node's CURRENT config — otherwise rebuilding from only the flags
  // passed this call would reset omitted fields to builder defaults (wiping the
  // existing credential/javaPath/port, or the demand delays). Parse once, then
  // fill each unset field from the current value.
  const current = parseNodeConfig(xml);

  const launcherTouched =
    opts.launcherType !== undefined ||
    opts.host !== undefined ||
    opts.port !== undefined ||
    opts.credentialsId !== undefined ||
    opts.javaPath !== undefined;

  if (launcherTouched) {
    const block = buildLauncherXml({
      type: opts.launcherType !== undefined ? opts.launcherType : current.launcherType,
      host: opts.host !== undefined ? opts.host : current.host,
      port: opts.port !== undefined ? opts.port : current.port,
      credentialsId: opts.credentialsId !== undefined ? opts.credentialsId : current.credentialsId,
      javaPath: opts.javaPath !== undefined ? opts.javaPath : current.javaPath,
    });
    xml = swapElement(xml, "launcher", block);
  }

  const retentionTouched =
    opts.availability !== undefined ||
    opts.inDemandDelay !== undefined ||
    opts.idleDelay !== undefined;

  if (retentionTouched) {
    const block = buildRetentionXml({
      availability: opts.availability !== undefined ? opts.availability : current.availability,
      inDemandDelay: opts.inDemandDelay !== undefined ? opts.inDemandDelay : current.inDemandDelay,
      idleDelay: opts.idleDelay !== undefined ? opts.idleDelay : current.idleDelay,
    });
    xml = swapElement(xml, "retentionStrategy", block);
  }

  await client.postXml(`/computer/${nodeSeg(name)}/config.xml`, xml, { invalidate: "nodes." });
}
