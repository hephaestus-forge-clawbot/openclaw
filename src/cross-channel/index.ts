/**
 * Cross-Channel Intelligence (Hephie Phase 3.1 + 3.2 + 3.3 + 3.4)
 *
 * One agent, multiple surfaces, unified context.
 *
 * Phase 3.1: Unified Session Context
 * Phase 3.2: Cross-Channel Messaging
 * Phase 3.3: Unified Threading
 * Phase 3.4: Smart Channel Selection
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

// ── Phase 3.3: Unified Threading ─────────────────────────────────────────

export type {
  ThreadStatus,
  ThreadMessage,
  PlatformThreadMapping,
  UnifiedThread,
  ThreadSearchCriteria,
  ThreadConfig,
  ThreadContextInjection,
} from "./thread-types.js";
export { DEFAULT_THREAD_CONFIG } from "./thread-types.js";

export { ThreadStore, initializeThreadSchema, type ThreadDatabase } from "./thread-store.js";

export {
  extractTokens,
  extractEntities,
  computeTokenSimilarity,
  computeBigramSimilarity,
  computeTopicSimilarity,
  computeThreadSimilarity,
} from "./topic-similarity.js";

export { ThreadLinker, type LinkResult } from "./thread-linker.js";

export {
  assembleThreadContext,
  buildThreadContextSection,
  type ThreadContextParams,
} from "./thread-context.js";

export { ThreadManager, type MaintenanceResult, type SummaryGenerator } from "./thread-manager.js";

// ── Phase 3.4: Smart Channel Selection ───────────────────────────────────

export type {
  KnownMessageType,
  MessageType,
  UrgencyLevel,
  UserChannelActivity,
  StalenessThresholds,
  AvailabilityStatus,
  ChannelAvailability,
  ChannelPreference,
  UserChannelPreferences,
  AffinityRule,
  AffinityConfig,
  FallbackChain,
  ChannelSelectionRequest,
  ChannelRecommendation,
  ChannelSelectionResult,
  SmartChannelSelectorConfig,
} from "./channel-selector-types.js";
export {
  DEFAULT_STALENESS_THRESHOLDS,
  DEFAULT_AFFINITY_RULES,
  DEFAULT_AFFINITY_CONFIG,
  DEFAULT_SELECTOR_CONFIG,
} from "./channel-selector-types.js";

export { UserAvailabilityTracker } from "./user-availability.js";

export {
  ChannelPreferenceLearner,
  DEFAULT_LEARNER_CONFIG,
  type MessageObservation,
  type PreferenceLearnerConfig,
} from "./channel-preferences.js";

export { ChannelAffinityMapper } from "./channel-affinity.js";

export { SmartChannelSelector } from "./channel-selector.js";
