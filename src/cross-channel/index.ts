/**
 * Cross-Channel Intelligence (Hephie Phase 3.1)
 *
 * One agent, multiple surfaces, unified context.
 */

export type {
  ChannelType,
  ChannelHistoryEntry,
  ChannelIdentity,
  UserIdentityMap,
  CrossChannelContextEntry,
  CrossChannelContext,
  CrossChannelConfig,
} from "./types.js";
export { DEFAULT_CROSS_CHANNEL_CONFIG } from "./types.js";

export { ChannelHistoryTracker, normalizeChannelType } from "./channel-history.js";

export {
  IdentityStore,
  parseIdentitiesFromPersonFile,
  formatIdentitiesSection,
} from "./identity-map.js";

export {
  assembleCrossChannelContext,
  formatCrossChannelContext,
  type SessionInfo,
} from "./context-bridge.js";

export {
  updateChannelHistory,
  extractChannelType,
  extractSenderIdentity,
  sessionsMatchPerson,
  type CrossChannelSessionFields,
} from "./session-enhancer.js";

export {
  scanPersonFiles,
  personNameFromPath,
  personFileExists,
  readPersonIdentities,
  type MigrationResult,
  type PersonFileScanResult,
} from "./person-file-migration.js";

export {
  buildCrossChannelSection,
  shouldInjectCrossChannelContext,
} from "./context-injector-integration.js";
