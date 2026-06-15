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
  /** Enable or disable Folders Plus controlled-agent mode (SecurityTokensNodeProperty). */
  controlledAgent?: boolean;
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
  /** Whether Folders Plus controlled-agent mode is currently enabled. */
  controlledAgent: boolean;
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
    controlledAgent: xml.includes("SecurityTokensNodeProperty"),
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

  // Patch controlled-agent property inline before posting, so a single
  // config.xml round-trip handles both node fields and this flag together.
  if (opts.controlledAgent !== undefined) {
    const PROP_TAG = "com.cloudbees.jenkins.plugins.foldersplus.SecurityTokensNodeProperty";
    const propBlock = `  <${PROP_TAG}>\n    <acceptTasksWithoutOwningItem>false</acceptTasksWithoutOwningItem>\n  </${PROP_TAG}>`;
    const propRe = new RegExp(`[ \\t]*<${PROP_TAG}[\\s\\S]*?</${PROP_TAG}>`);
    const propSelfRe = new RegExp(`[ \\t]*<${PROP_TAG}\\s*/>`);
    if (opts.controlledAgent) {
      if (!propRe.test(xml) && !propSelfRe.test(xml)) {
        if (/<nodeProperties>/.test(xml)) {
          xml = xml.replace(/<nodeProperties>/, `<nodeProperties>\n${propBlock}`);
        } else {
          const rootCloseRe = /<\/(slave|agent|hudson\.slaves\.DumbSlave)\s*>/;
          xml = xml.replace(rootCloseRe, `  <nodeProperties>\n${propBlock}\n  </nodeProperties>\n</$1>`);
        }
      }
    } else {
      xml = xml.replace(propRe, "").replace(propSelfRe, "").replace(/\n{3,}/g, "\n\n");
    }
  }

  await client.postXml(`/computer/${nodeSeg(name)}/config.xml`, xml, { invalidate: "nodes." });
}

// ── Folders Plus controlled-agent handshake ──────────────────────────────────

/**
 * Enable or disable "Only accept builds from approved folders" on an agent.
 * This sets the SecurityTokensNodeProperty on the agent's configSubmit.
 * Must be called before any approve-folder handshake can be performed.
 */
export async function setControlledAgent(
  client: CloudBeesClient,
  nodeName: string,
  enable: boolean,
): Promise<void> {
  const xml = await client.getText(`/computer/${nodeSeg(nodeName)}/config.xml`);
  xmlParser.parse(xml); // validate well-formed

  const PROP_TAG = "com.cloudbees.jenkins.plugins.foldersplus.SecurityTokensNodeProperty";
  const propBlock = `  <${PROP_TAG}>\n    <acceptTasksWithoutOwningItem>false</acceptTasksWithoutOwningItem>\n  </${PROP_TAG}>`;

  let patched: string;
  const propRe = new RegExp(`[ \\t]*<${PROP_TAG}[\\s\\S]*?</${PROP_TAG}>`);
  const propSelfRe = new RegExp(`[ \\t]*<${PROP_TAG}\\s*/>`);

  if (enable) {
    if (propRe.test(xml) || propSelfRe.test(xml)) {
      patched = xml; // already present
    } else {
      // Insert inside <nodeProperties> if it exists, else before root close tag
      if (/<nodeProperties>/.test(xml)) {
        patched = xml.replace(/<nodeProperties>/, `<nodeProperties>\n${propBlock}`);
      } else {
        const rootCloseRe = /<\/(slave|agent|hudson\.slaves\.DumbSlave)\s*>/;
        patched = xml.replace(rootCloseRe, `  <nodeProperties>\n${propBlock}\n  </nodeProperties>\n</$1>`);
      }
    }
  } else {
    patched = xml
      .replace(propRe, "")
      .replace(propSelfRe, "")
      .replace(/\n{3,}/g, "\n\n");
  }

  await client.postXml(`/computer/${nodeSeg(nodeName)}/config.xml`, patched, { invalidate: "nodes." });
}

/** Extract `input[name="_.hash"]` value from the authorize HTML response. */
function extractHashFromHtml(html: string): string {
  const m = html.match(/name=["']_\.hash["'][^>]*value=["']([0-9a-f]+)["']/i)
    ?? html.match(/value=["']([0-9a-f]{32,})["'][^>]*name=["']_\.hash["']/i);
  if (!m?.[1]) throw new Error("Could not find Request Secret (_.hash) in agent authorize response");
  return m[1];
}

/**
 * Step 1 (folder side): create a controlled-agent request for a folder.
 * Returns the grantId (= Request Key to hand to the agent admin).
 */
export async function createFolderRequest(
  client: CloudBeesClient,
  folderName: string,
): Promise<string> {
  const folderPath = folderName.split("/").map(encodeURIComponent).join("/job/");
  const html = await client.post<string>(
    `/job/${folderPath}/controlled-slaves/requestSubmit`,
    {
      body: formEncode({ Submit: "Yes" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
  );
  // Jenkins 302-redirects to grantsById/{id}; fetch follows so html is the landed page
  const m = html?.match(/\/controlled-slaves\/grantsById\/([^/"'?#\s]+)/);
  if (!m?.[1]) throw new Error("Could not extract grantId from folder request response");
  return m[1];
}

/**
 * Step 2 (agent side): create a new security token on the agent.
 * Returns the tokenId.
 */
export async function createAgentToken(
  client: CloudBeesClient,
  nodeName: string,
): Promise<string> {
  const html = await client.post<string>(
    `/computer/${nodeSeg(nodeName)}/security-tokens/createSubmit`,
    {
      body: formEncode({ Submit: "Yes" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
  );
  const m = html?.match(/\/security-tokens\/tokensById\/([^/"'?#\s]+)/);
  if (!m?.[1]) throw new Error("Could not extract tokenId from create-token response");
  return m[1];
}

/**
 * Step 3 (agent side): authorize the grant request using the agent's token.
 * `grantId` is the Request Key from the folder side.
 * Returns the Request Secret (hash) to pass back to the folder admin.
 */
export async function authorizeAgentToken(
  client: CloudBeesClient,
  nodeName: string,
  tokenId: string,
  grantId: string,
): Promise<string> {
  const html = await client.post<string>(
    `/computer/${nodeSeg(nodeName)}/security-tokens/tokensById/${encodeURIComponent(tokenId)}/authorizeSubmit`,
    {
      body: formEncode({ "_.salt": grantId, Submit: "Authorize" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
  );
  return extractHashFromHtml(String(html ?? ""));
}

/**
 * Step 4 (folder side): complete the handshake by submitting the Request Secret.
 * `grantId` is the Request Key; `requestSecret` is the hash from the agent side.
 */
export async function authorizeFolderGrant(
  client: CloudBeesClient,
  folderName: string,
  grantId: string,
  requestSecret: string,
): Promise<void> {
  const folderPath = folderName.split("/").map(encodeURIComponent).join("/job/");
  await client.post(
    `/job/${folderPath}/controlled-slaves/grantsById/${encodeURIComponent(grantId)}/authorizeSubmit`,
    {
      body: formEncode({ "_.salt": grantId, "_.hash": requestSecret, Submit: "Authorize" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
  );
}

/**
 * Full approve-folder handshake in one call (requires admin on both agent and folder).
 * 1. Enable controlled-agent on node (if not already)
 * 2. Folder creates request → grantId
 * 3. Agent creates token → tokenId
 * 4. Agent authorizes → requestSecret
 * 5. Folder authorizes with secret
 */
export async function approveFolder(
  client: CloudBeesClient,
  nodeName: string,
  folderName: string,
): Promise<void> {
  await setControlledAgent(client, nodeName, true);
  const grantId = await createFolderRequest(client, folderName);
  const tokenId = await createAgentToken(client, nodeName);
  const requestSecret = await authorizeAgentToken(client, nodeName, tokenId, grantId);
  await authorizeFolderGrant(client, folderName, grantId, requestSecret);
}

export interface ApprovedFolder {
  /** Folder name extracted from the job URL path, or null when the token is unassigned (pending). */
  folderName: string | null;
  tokenId: string;
}

/**
 * List folders approved to run on a controlled agent.
 * Parses the HTML table at `/computer/<agent>/security-tokens/`.
 * Returns [] when controlled-agent mode is not enabled or the plugin is not installed.
 */
export async function listApprovedFolders(
  client: CloudBeesClient,
  nodeName: string,
): Promise<ApprovedFolder[]> {
  let html: string;
  try {
    html = await client.getText(`/computer/${nodeSeg(nodeName)}/security-tokens/`);
  } catch {
    return [];
  }

  const folders: ApprovedFolder[] = [];

  // Split by <tr> so each chunk is one row, then extract tokenId and folderName.
  const rows = html.split(/<tr[^>]*>/i).slice(1); // skip before first <tr>
  for (const row of rows) {
    // tokenId from the delete link in this row (href may be relative or absolute)
    const tokenMatch = row.match(/href="[^"]*\/tokensById\/([^/"]+)\/doDelete"/);
    if (!tokenMatch) continue;
    const tokenId = tokenMatch[1]!;

    // folderName from a /job/<name>/ href in this row
    const folderMatch = row.match(/href="[^"]*\/job\/([^"?#]+\/)"[^>]*>\s*([^<]+)\s*<\/a>/);
    const folderName = folderMatch
      ? decodeURIComponent(
          folderMatch[1]!
            .replace(/\/$/, "")        // strip trailing /
            .replace(/\/job\//g, "/"), // /a/job/b/ → /a/b/
        )
      : null;

    folders.push({ folderName, tokenId });
  }

  return folders;
}
