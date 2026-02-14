/**
 * Cross-Channel Intelligence (Hephie Phase 3.1 + 3.2)
 *
 * One agent, multiple surfaces, unified context.
 *
 * Phase 3.1: Unified Session Context
 * Phase 3.2: Cross-Channel Messaging
 */

// ── Phase 3.1: Types & Core ──────────────────────────────────────────────

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

// ── Phase 3.2: Reply Routing ─────────────────────────────────────────────

export { ReplyRouter, type ReplyRoute } from "./reply-router.js";

// ── Phase 3.2: Message Queue ─────────────────────────────────────────────

export {
  MessageQueue,
  calculateRetryDelay,
  DEFAULT_RETRY_POLICY,
  type QueuedMessage,
  type RetryPolicy,
  type MessageQueueConfig,
  type QueueStats,
} from "./message-queue.js";

// ── Phase 3.2: Cross-Channel Sender ──────────────────────────────────────

export {
  CrossChannelSender,
  type ChannelSendFn,
  type SendResult,
  type BroadcastResult,
  type SendOptions,
  type BroadcastOptions,
  type ChannelTarget,
} from "./cross-channel-sender.js";

// ── Phase 3.2: Message Path Hooks ────────────────────────────────────────

export {
  processInboundForCrossChannel,
  assembleCrossChannelPromptSection,
  extractMessageIdentity,
  type InboundHookParams,
  type InboundHookResult,
  type PromptHookParams,
  type PromptHookResult,
} from "./message-path-hooks.js";

// ── Phase 3.2: Send CLI Command ──────────────────────────────────────────

export {
  parseSendArgs,
  validateSendArgs,
  executeSendCommand,
  SEND_COMMAND_HELP,
  type SendCommandArgs,
  type SendCommandResult,
} from "./send-command.js";
