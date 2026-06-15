/**
 * Folders Plus service — CloudBees Folders Plus plugin features.
 * Controlled-agent handshake: approve a folder on an agent via the
 * 5-step key/secret exchange.
 */
export {
  setControlledAgent,
  createFolderRequest,
  createAgentToken,
  authorizeAgentToken,
  authorizeFolderGrant,
  approveFolder,
} from "../node/service";
