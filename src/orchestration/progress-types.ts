/**
 * Progress Event Types (Hephie Phase 4.1)
 *
 * Defines the event taxonomy for real-time sub-agent progress observability.
 * Events flow from sub-agent sessions through the progress tracker into
 * the progress store and stream API.
 */

// ── Event Types ─────────────────────────────────────────────────────────

/**
 * All possible progress event types.
 */
export type ProgressEventType =
  | "SPAWNED"
  | "STARTED"
  | "PROGRESS"
  | "TOOL_CALL"
  | "THINKING"
  | "COMPLETED"
  | "FAILED";

/**
 * All valid event types as a readonly array for validation.
 */
export const PROGRESS_EVENT_TYPES: readonly ProgressEventType[] = [
  "SPAWNED",
  "STARTED",
  "PROGRESS",
  "TOOL_CALL",
  "THINKING",
  "COMPLETED",
  "FAILED",
] as const;

/**
 * Terminal event types that indicate the session is no longer active.
 */
export const TERMINAL_EVENT_TYPES: ReadonlySet<ProgressEventType> = new Set([
  "COMPLETED",
  "FAILED",
]);

// ── Progress Metrics ────────────────────────────────────────────────────

/**
 * Quantitative progress metrics for a sub-agent run.
 */
export interface ProgressMetrics {
  /** Number of steps/actions completed so far. */
  stepsCompleted: number;
  /** Estimated total steps remaining (if estimable). */
  estimatedRemaining?: number;
  /** Confidence level (0.0 - 1.0) of the progress estimate. */
  confidence?: number;
  /** Total tool calls made so far. */
  toolCallCount: number;
  /** Total thinking blocks processed. */
  thinkingBlockCount: number;
}

/**
 * Create default (zero) progress metrics.
 */
export function createDefaultMetrics(): ProgressMetrics {
  return {
    stepsCompleted: 0,
    toolCallCount: 0,
    thinkingBlockCount: 0,
  };
}

// ── Event Payload ───────────────────────────────────────────────────────

/**
 * Additional metadata attached to events.
 */
export interface ProgressEventMetadata {
  /** The tool name for TOOL_CALL events. */
  toolName?: string;
  /** Duration of the action in milliseconds. */
  durationMs?: number;
  /** Error message for FAILED events. */
  error?: string;
  /** Model used by the sub-agent. */
  model?: string;
  /** Thinking level used. */
  thinkingLevel?: string;
  /** Parent session key for linking. */
  parentSessionKey?: string;
  /** Arbitrary extra data. */
  extra?: Record<string, unknown>;
}

/**
 * A single progress event emitted by a sub-agent session.
 */
export interface ProgressEvent {
  /** Unique event ID. */
  eventId: string;
  /** ISO 8601 timestamp of when this event occurred. */
  timestamp: number;
  /** The session key of the sub-agent. */
  sessionKey: string;
  /** Human-readable label for the sub-agent. */
  agentLabel: string;
  /** The type of progress event. */
  eventType: ProgressEventType;
  /** Human-readable message describing the event. */
  message: string;
  /** Quantitative progress metrics snapshot at event time. */
  metrics: ProgressMetrics;
  /** Additional metadata. */
  metadata?: ProgressEventMetadata;
}

// ── Aggregate Metrics ───────────────────────────────────────────────────

/**
 * Aggregated metrics for a session or group of sessions.
 */
export interface AggregateMetrics {
  /** Total events recorded. */
  totalEvents: number;
  /** Breakdown by event type. */
  eventsByType: Record<ProgressEventType, number>;
  /** Completion percentage (0-100). Based on terminal vs active. */
  completionPercent: number;
  /** Time elapsed from first SPAWNED to latest event (ms). */
  elapsedMs: number;
  /** Total tool calls across all events. */
  totalToolCalls: number;
  /** Unique tool names used. */
  uniqueTools: string[];
  /** Number of active (non-terminal) sessions. */
  activeSessions: number;
  /** Number of completed sessions. */
  completedSessions: number;
  /** Number of failed sessions. */
  failedSessions: number;
}

/**
 * Create empty aggregate metrics.
 */
export function createEmptyAggregateMetrics(): AggregateMetrics {
  return {
    totalEvents: 0,
    eventsByType: {
      SPAWNED: 0,
      STARTED: 0,
      PROGRESS: 0,
      TOOL_CALL: 0,
      THINKING: 0,
      COMPLETED: 0,
      FAILED: 0,
    },
    completionPercent: 0,
    elapsedMs: 0,
    totalToolCalls: 0,
    uniqueTools: [],
    activeSessions: 0,
    completedSessions: 0,
    failedSessions: 0,
  };
}

// ── Query Types ─────────────────────────────────────────────────────────

/**
 * Criteria for querying progress events.
 */
export interface ProgressQueryCriteria {
  /** Filter by session key. */
  sessionKey?: string;
  /** Filter by agent label (supports LIKE matching). */
  agentLabel?: string;
  /** Filter by event type(s). */
  eventTypes?: ProgressEventType[];
  /** Only events after this timestamp (ms). */
  since?: number;
  /** Only events before this timestamp (ms). */
  until?: number;
  /** Maximum number of results. */
  limit?: number;
  /** Offset for pagination. */
  offset?: number;
  /** Order direction. */
  order?: "asc" | "desc";
}

/**
 * Options for subscribing to the progress stream.
 */
export interface ProgressSubscriptionOptions {
  /** Only events for this session key. */
  sessionKey?: string;
  /** Only these event types. */
  eventTypes?: ProgressEventType[];
  /** Batch updates at this interval (ms). 0 = immediate. */
  batchIntervalMs?: number;
}

// ── Validation ──────────────────────────────────────────────────────────

/**
 * Check if a value is a valid ProgressEventType.
 */
export function isValidEventType(value: unknown): value is ProgressEventType {
  return typeof value === "string" && PROGRESS_EVENT_TYPES.includes(value as ProgressEventType);
}

/**
 * Check if an event type is terminal (COMPLETED or FAILED).
 */
export function isTerminalEvent(eventType: ProgressEventType): boolean {
  return TERMINAL_EVENT_TYPES.has(eventType);
}
