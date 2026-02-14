/**
 * Progress CLI Command (Hephie Phase 4.1)
 *
 * CLI interface for sub-agent progress observability.
 *
 * Commands:
 *   hephie progress --session <key>   Show progress for specific session
 *   hephie progress --active          All active sub-agents
 *   hephie progress --watch <key>     Live stream (updates every 2s)
 *   hephie progress --summary         Aggregated stats
 */

import type { ProgressStore } from "./progress-store.js";
import type { ProgressEvent, AggregateMetrics } from "./progress-types.js";
import { TERMINAL_EVENT_TYPES } from "./progress-types.js";

// ── Formatting ──────────────────────────────────────────────────────────

/**
 * Format a timestamp as a human-readable string.
 */
export function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Format elapsed milliseconds as a human-readable duration.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Truncate a string to a max length with ellipsis.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) {
    return str;
  }
  return str.slice(0, maxLen - 3) + "...";
}

/**
 * Event type emoji mapping.
 */
const EVENT_EMOJI: Record<string, string> = {
  SPAWNED: "🥚",
  STARTED: "🚀",
  PROGRESS: "📊",
  TOOL_CALL: "🔧",
  THINKING: "💭",
  COMPLETED: "✅",
  FAILED: "❌",
};

// ── Formatters ──────────────────────────────────────────────────────────

/**
 * Format a single progress event for display.
 */
export function formatEvent(event: ProgressEvent): string {
  const emoji = EVENT_EMOJI[event.eventType] ?? "•";
  const time = formatTimestamp(event.timestamp);
  const label = truncate(event.agentLabel, 30);
  const msg = truncate(event.message, 60);
  const steps = `[${event.metrics.stepsCompleted} steps, ${event.metrics.toolCallCount} tools]`;

  return `${emoji} ${time}  ${label}  ${event.eventType.padEnd(10)}  ${msg}  ${steps}`;
}

/**
 * Format a session summary (latest event + metrics).
 */
export function formatSessionSummary(events: ProgressEvent[]): string {
  if (events.length === 0) {
    return "No events recorded.";
  }

  const first = events[0];
  const last = events[events.length - 1];
  const isTerminal = TERMINAL_EVENT_TYPES.has(last.eventType);
  const elapsed = last.timestamp - first.timestamp;

  const lines: string[] = [];
  lines.push(`Session: ${first.sessionKey}`);
  lines.push(`Agent:   ${first.agentLabel}`);
  lines.push(`Status:  ${isTerminal ? last.eventType : "ACTIVE"}`);
  lines.push(`Events:  ${events.length}`);
  lines.push(`Elapsed: ${formatDuration(elapsed)}`);
  lines.push(`Steps:   ${last.metrics.stepsCompleted}`);
  lines.push(`Tools:   ${last.metrics.toolCallCount}`);
  lines.push(`Thinking: ${last.metrics.thinkingBlockCount}`);

  if (last.metadata?.parentSessionKey) {
    lines.push(`Parent:  ${last.metadata.parentSessionKey}`);
  }

  lines.push("");
  lines.push("Events:");
  for (const evt of events) {
    lines.push(`  ${formatEvent(evt)}`);
  }

  return lines.join("\n");
}

/**
 * Format active sessions list.
 */
export function formatActiveSessions(
  activeSessions: Array<{ sessionKey: string; events: ProgressEvent[] }>,
): string {
  if (activeSessions.length === 0) {
    return "No active sub-agents.";
  }

  const lines: string[] = [];
  lines.push(`Active Sub-Agents: ${activeSessions.length}`);
  lines.push("─".repeat(80));

  for (const session of activeSessions) {
    const events = session.events;
    if (events.length === 0) {
      continue;
    }

    const first = events[0];
    const last = events[events.length - 1];
    const elapsed = last.timestamp - first.timestamp;

    lines.push(
      `  ${first.agentLabel}  |  ${last.eventType}  |  ${last.metrics.stepsCompleted} steps  |  ${formatDuration(elapsed)}  |  ${truncate(first.sessionKey, 40)}`,
    );
  }

  return lines.join("\n");
}

/**
 * Format aggregate summary.
 */
export function formatSummary(metrics: AggregateMetrics): string {
  const lines: string[] = [];
  lines.push("Sub-Agent Progress Summary");
  lines.push("═".repeat(40));
  lines.push(`Total Events:      ${metrics.totalEvents}`);
  lines.push(`Active Sessions:   ${metrics.activeSessions}`);
  lines.push(`Completed:         ${metrics.completedSessions}`);
  lines.push(`Failed:            ${metrics.failedSessions}`);
  lines.push(`Completion:        ${metrics.completionPercent}%`);
  lines.push(`Total Elapsed:     ${formatDuration(metrics.elapsedMs)}`);
  lines.push(`Total Tool Calls:  ${metrics.totalToolCalls}`);

  if (metrics.uniqueTools.length > 0) {
    lines.push(`Unique Tools:      ${metrics.uniqueTools.join(", ")}`);
  }

  lines.push("");
  lines.push("Events by Type:");
  for (const [type, count] of Object.entries(metrics.eventsByType)) {
    const emoji = EVENT_EMOJI[type] ?? "•";
    lines.push(`  ${emoji} ${type.padEnd(12)} ${count}`);
  }

  return lines.join("\n");
}

// ── Command Execution ───────────────────────────────────────────────────

/**
 * Options for the progress command.
 */
export interface ProgressCommandOptions {
  /** Show progress for a specific session. */
  session?: string;
  /** Show all active sub-agents. */
  active?: boolean;
  /** Show aggregated stats. */
  summary?: boolean;
  /** Live watch mode (not implemented in initial version). */
  watch?: string;
}

/**
 * Execute the progress command and return formatted output.
 */
export function executeProgressCommand(
  store: ProgressStore,
  options: ProgressCommandOptions,
): string {
  if (options.session) {
    const events = store.getSessionEvents(options.session);
    return formatSessionSummary(events);
  }

  if (options.active) {
    const activeKeys = store.getActiveSessions();
    const activeSessions = activeKeys.map((sessionKey) => ({
      sessionKey,
      events: store.getSessionEvents(sessionKey),
    }));
    return formatActiveSessions(activeSessions);
  }

  if (options.summary) {
    const metrics = store.getAggregateMetrics();
    return formatSummary(metrics);
  }

  if (options.watch) {
    // Watch mode returns current state — real-time streaming
    // would need a long-running process which is out of scope for
    // the synchronous command, but the stream API supports it.
    const events = store.getSessionEvents(options.watch);
    return formatSessionSummary(events);
  }

  // Default: show summary
  const metrics = store.getAggregateMetrics();
  return formatSummary(metrics);
}
