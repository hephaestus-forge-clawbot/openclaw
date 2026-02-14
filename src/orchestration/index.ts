/**
 * Orchestration Module (Hephie Phase 4)
 *
 * Sub-agent observability and progress tracking infrastructure.
 */

export {
  type ProgressEventType,
  type ProgressMetrics,
  type ProgressEvent,
  type ProgressEventMetadata,
  type AggregateMetrics,
  type ProgressQueryCriteria,
  type ProgressSubscriptionOptions,
  PROGRESS_EVENT_TYPES,
  TERMINAL_EVENT_TYPES,
  createDefaultMetrics,
  createEmptyAggregateMetrics,
  isValidEventType,
  isTerminalEvent,
} from "./progress-types.js";

export { type ProgressDatabase, ProgressStore, createProgressSchema } from "./progress-store.js";

export { ProgressTracker, getProgressTracker, resetProgressTracker } from "./progress-tracker.js";

export {
  type ProgressEventListener,
  type ProgressBatchListener,
  type ProgressSubscription,
  ProgressStream,
  getProgressStream,
  resetProgressStream,
} from "./progress-stream.js";

export {
  type ProgressCommandOptions,
  executeProgressCommand,
  formatEvent,
  formatSessionSummary,
  formatActiveSessions,
  formatSummary,
  formatTimestamp,
  formatDuration,
} from "./progress-command.js";
