/**
 * Controller service — list, get, select, resolve, capabilities.
 * Ports legacy/cb/services/controller_service.py
 */

import { CloudBeesClientImpl } from "../../core/api/index";
import { AuthError, NotFoundError, APIError } from "../../core/api/index";
import type { CloudBeesClient } from "../../core/api/types";
import { controllerFromDict } from "../../core/dtos/index";
import type { ControllerDTO } from "../../core/dtos/index";
import { setSetting } from "../../core/db/repositories/settings-repo";
import { getCached, setCache } from "../../core/cache/index";
import { getActiveController as coreGetActiveController } from "../../core/client-factory";
import type { CapabilityInfo } from "./types";

/** Controller _class fragments that identify controllers (mirrors Python _CONTROLLER_CLASSES). */
const CONTROLLER_CLASS_FRAGMENTS = ["Master", "Controller", "ConnectedMaster", "ManagedMaster"];

/**
 * List all controllers visible on the CloudBees server.
 * Mirrors Python list_controllers().
 */
export async function listControllers(client: CloudBeesClient): Promise<ControllerDTO[]> {
  const data = await client.get<Record<string, unknown>>(
    "/api/json?tree=jobs[_class,name,url,description,offline]",
    { cacheKey: "controllers.list" },
  );

  const jobs = (Array.isArray((data ?? {})["jobs"]) ? (data as Record<string, unknown[]>)["jobs"] : []) as Record<string, unknown>[];

  const controllers: ControllerDTO[] = [];
  for (const j of jobs) {
    const cls = typeof j["_class"] === "string" ? j["_class"] : "";
    if (CONTROLLER_CLASS_FRAGMENTS.some((f) => cls.includes(f))) {
      controllers.push(controllerFromDict(j));
    }
  }

  // If no class-matched controllers, return all jobs mapped as controllers
  if (controllers.length === 0) {
    return jobs.map(controllerFromDict);
  }
  return controllers;
}

/**
 * Fetch a single controller by name.
 * Mirrors Python get_controller().
 */
export async function getController(client: CloudBeesClient, name: string): Promise<ControllerDTO> {
  const data = await client.get<Record<string, unknown>>(
    `/job/${name}/api/json`,
    { cacheKey: `controllers.detail.${name}` },
  );
  return controllerFromDict(data ?? {});
}

/**
 * Persist the active controller selection to the settings table.
 * Mirrors Python select_controller().
 */
export function selectController(name: string, url: string, dbPath?: string): void {
  setSetting("active_controller", name, dbPath);
  setSetting("active_controller_url", url, dbPath);
}

/**
 * Follow the CJOC 302 redirect to find the real Ingress URL, stripping SSO suffixes.
 * Mirrors Python resolve_controller_url().
 */
export async function resolveControllerUrl(client: CloudBeesClient, cjocUrl: string): Promise<string> {
  const realUrl = await client.resolveRedirect(cjocUrl);
  if (realUrl) {
    if (realUrl.includes("operations-center-sso-navigate")) {
      return realUrl.split("operations-center-sso-navigate")[0];
    }
    return realUrl;
  }
  return cjocUrl;
}

/**
 * Return (name, url) of the active controller, or null.
 * Delegates to core/client-factory to avoid duplication.
 */
export function getActiveController(dbPath?: string): [string, string] | null {
  return coreGetActiveController(dbPath);
}

/**
 * Fetch controller detail and derive create permissions by probing endpoints.
 * Mirrors Python get_controller_capabilities() exactly.
 *
 * Accepts rawToken separately because CloudBeesClient.token is not on the interface —
 * callers must pass (client as CloudBeesClientImpl).token or supply it from context.
 */
export async function getControllerCapabilities(
  client: CloudBeesClient,
  name: string,
  rawToken: string,
): Promise<CapabilityInfo> {
  const dbPath = (client as CloudBeesClientImpl)["_dbPath"] as string | undefined;
  const cacheKey = `controllers.capabilities.${name}`;
  const cached = getCached(cacheKey, dbPath);
  if (cached !== null && typeof cached === "object" && cached !== null) {
    return cached as CapabilityInfo;
  }

  const dto = await getController(client, name);
  const cls = dto.className;

  if (!dto.online) {
    return {
      name: dto.name,
      url: dto.url,
      description: dto.description,
      typeLabel: "Offline",
      online: false,
      canCreateJob: false,
      canCreateNode: false,
      canCreateCred: false,
    };
  }

  // Determine label from class
  let typeLabel: string;
  if (cls.includes("ManagedMaster")) {
    typeLabel = "Managed Master";
  } else if (cls.includes("ConnectedMaster")) {
    typeLabel = "Connected Master";
  } else if (cls.includes("Beekeeper")) {
    typeLabel = "Upgrading...";
  } else {
    typeLabel = cls.includes(".") ? cls.split(".").pop()! : cls || "Unknown";
  }

  let canCreateJob: boolean;
  let canCreateNode: boolean;
  let canCreateCred: boolean;

  if (cls.includes("Beekeeper")) {
    canCreateJob = false;
    canCreateNode = false;
    canCreateCred = false;
  } else {
    // Resolve real URL from CJOC proxy URL
    const realUrl = await resolveControllerUrl(client, dto.url);
    // Probe client bound to the controller's real URL
    const ctrlClient = new CloudBeesClientImpl(realUrl, rawToken);

    // 1. Job probe — 400 means we're allowed but missing XML payload
    try {
      await ctrlClient.post("/createItem?name=probe_test");
      canCreateJob = true;
    } catch (err) {
      if (err instanceof AuthError || err instanceof NotFoundError) {
        canCreateJob = false;
      } else if (err instanceof APIError) {
        canCreateJob = (err as APIError).statusCode === 400;
      } else {
        canCreateJob = false;
      }
    }

    // 2. Node probe
    try {
      await ctrlClient.post("/computer/doCreateItem?name=probe_tester&type=hudson.slaves.DumbSlave");
      canCreateNode = true;
    } catch (err) {
      if (err instanceof AuthError || err instanceof NotFoundError) {
        canCreateNode = false;
      } else if (err instanceof APIError) {
        canCreateNode = (err as APIError).statusCode === 400;
      } else {
        canCreateNode = false;
      }
    }

    // 3. Credential probe
    // Mirrors credential_service._get_user_seg("") for store=system, username=""
    // → "/credentials/store/system/domain/_"
    const userSeg = "/credentials/store/system/domain/_";
    try {
      await ctrlClient.post(`${userSeg}/createCredentials`);
      canCreateCred = true;
    } catch (err) {
      if (err instanceof AuthError || err instanceof NotFoundError) {
        canCreateCred = false;
      } else if (err instanceof APIError) {
        // 405 Method Not Allowed also proves endpoint visibility
        canCreateCred = [400, 405].includes((err as APIError).statusCode ?? 0);
      } else {
        canCreateCred = false;
      }
    }
  }

  const caps: CapabilityInfo = {
    name: dto.name,
    url: dto.url,
    description: dto.description ?? "",
    typeLabel,
    online: true,
    canCreateJob,
    canCreateNode,
    canCreateCred,
  };

  setCache(cacheKey, caps, undefined, dbPath);
  return caps;
}
