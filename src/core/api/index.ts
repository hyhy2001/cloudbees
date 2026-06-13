/**
 * Public surface of the core/api module.
 * Re-exports everything consumers need — client, errors, crumb utilities, and types.
 */

export { CloudBeesClientImpl } from "./client";
export {
  CBError,
  APIError,
  AuthError,
  NotFoundError,
  CBConnectionError,
  ConnectionError,
  ValidationError,
  ConfigError,
} from "./errors";
export { getCrumb, invalidateCrumb } from "./crumb";
export type { CrumbData, CrumbClient } from "./crumb";
export type { CloudBeesClient, ProgressiveText, RequestBody } from "./types";
