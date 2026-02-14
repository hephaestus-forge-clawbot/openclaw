/**
 * Progress Tracker (Hephie Phase 4.1)
 *
 * Hooks into the sub-agent session lifecycle to automatically emit
 * progress events. Tracks tool calls, thinking blocks, and completion.
 * Links parent-child sessions.
 */

import { randomUUID } from "node:crypto";
import type { ProgressStore } from "./progress-store.js";
import type {
  ProgressEvent,
  ProgressEventType,
  ProgressEventMetadata,
  ProgressMetrics,
} from "./progress-types.js";
import { type ProgressStream, getProgressStream } from "./progress-stream.js";
import { createDefaultMetrics } from "./progress-types.js";

// ── Session State ───────────────────────────────────────────────────────

/**
 * Internal state tracked per sub-agent session.
 */
interface SessionState {
  sessionKey: string;
  agentLabel: string;
  parentSessionKey?: string;
  metrics: ProgressMetrics;
  startedAt: number;
  lastEventAt: number;
  isTerminal: boolean;
}

// ── Progress Tracker ────────────────────────────────────────────────────

/**
 * Tracks sub-agent progress by observing session lifecycle events.
 *
 * Usage:
 * ```ts
 * const tracker = new ProgressTracker({ store, stream });
 * tracker.onSpawned({ sessionKey, agentLabel, parentSessionKey });
 * tracker.onToolCall({ sessionKey, toolName });
 * tracker.onCompleted({ sessionKey });
 * ```
 */
export class ProgressTracker {
  private readonly store: ProgressStore | null;
  private readonly stream: ProgressStream;
  private readonly sessions = new Map<string, SessionState>();

  constructor(opts: { store?: ProgressStore | null; stream?: ProgressStream }) {
    this.store = opts.store ?? null;
    this.stream = opts.stream ?? getProgressStream();
  }

  // ── Lifecycle Events ────────────────────────────────────────────────

  /**
   * Record a sub-agent spawn event.
   */
  onSpawned(params: {
    sessionKey: string;
    agentLabel: string;
    parentSessionKey?: string;
    model?: string;
    thinkingLevel?: string;
    task?: string;
    now?: number;
  }): ProgressEvent {
    const now = params.now ?? Date.now();

    const state: SessionState = {
      sessionKey: params.sessionKey,
      agentLabel: params.agentLabel,
      parentSessionKey: params.parentSessionKey,
      metrics: createDefaultMetrics(),
      startedAt: now,
      lastEventAt: now,
      isTerminal: false,
    };
    this.sessions.set(params.sessionKey, state);

    return this.emitEvent({
      sessionKey: params.sessionKey,
      agentLabel: params.agentLabel,
      eventType: "SPAWNED",
      message: params.task
        ? `Sub-agent spawned: ${params.task.slice(0, 200)}`
        : "Sub-agent spawned",
      metrics: state.metrics,
      metadata: {
        parentSessionKey: params.parentSessionKey,
        model: params.model,
        thinkingLevel: params.thinkingLevel,
      },
      timestamp: now,
    });
  }

  /**
   * Record a sub-agent start event (execution begins).
   */
  onStarted(params: { sessionKey: string; now?: number }): ProgressEvent | null {
    const state = this.sessions.get(params.sessionKey);
    if (!state || state.isTerminal) {
      return null;
    }
    const now = params.now ?? Date.now();
    state.lastEventAt = now;

    return this.emitEvent({
      sessionKey: state.sessionKey,
      agentLabel: state.agentLabel,
      eventType: "STARTED",
      message: "Sub-agent execution started",
      metrics: state.metrics,
      timestamp: now,
    });
  }

  /**
   * Record a generic progress update.
   */
  onProgress(params: {
    sessionKey: string;
    message?: string;
    stepsCompleted?: number;
    estimatedRemaining?: number;
    confidence?: number;
    now?: number;
  }): ProgressEvent | null {
    const state = this.sessions.get(params.sessionKey);
    if (!state || state.isTerminal) {
      return null;
    }
    const now = params.now ?? Date.now();
    state.lastEventAt = now;

    if (params.stepsCompleted !== undefined) {
      state.metrics.stepsCompleted = params.stepsCompleted;
    }
    if (params.estimatedRemaining !== undefined) {
      state.metrics.estimatedRemaining = params.estimatedRemaining;
    }
    if (params.confidence !== undefined) {
      state.metrics.confidence = params.confidence;
    }

    return this.emitEvent({
      sessionKey: state.sessionKey,
      agentLabel: state.agentLabel,
      eventType: "PROGRESS",
      message: params.message ?? "Progress update",
      metrics: { ...state.metrics },
      timestamp: now,
    });
  }

  /**
   * Record a tool call event.
   */
  onToolCall(params: {
    sessionKey: string;
    toolName: string;
    durationMs?: number;
    now?: number;
  }): ProgressEvent | null {
    const state = this.sessions.get(params.sessionKey);
    if (!state || state.isTerminal) {
      return null;
    }
    const now = params.now ?? Date.now();
    state.lastEventAt = now;
    state.metrics.toolCallCount++;
    state.metrics.stepsCompleted++;

    return this.emitEvent({
      sessionKey: state.sessionKey,
      agentLabel: state.agentLabel,
      eventType: "TOOL_CALL",
      message: `Tool call: ${params.toolName}`,
      metrics: { ...state.metrics },
      metadata: {
        toolName: params.toolName,
        durationMs: params.durationMs,
      },
      timestamp: now,
    });
  }

  /**
   * Record a thinking block event.
   */
  onThinking(params: {
    sessionKey: string;
    durationMs?: number;
    now?: number;
  }): ProgressEvent | null {
    const state = this.sessions.get(params.sessionKey);
    if (!state || state.isTerminal) {
      return null;
    }
    const now = params.now ?? Date.now();
    state.lastEventAt = now;
    state.metrics.thinkingBlockCount++;

    return this.emitEvent({
      sessionKey: state.sessionKey,
      agentLabel: state.agentLabel,
      eventType: "THINKING",
      message: "Processing thinking block",
      metrics: { ...state.metrics },
      metadata: {
        durationMs: params.durationMs,
      },
      timestamp: now,
    });
  }

  /**
   * Record a completion event.
   */
  onCompleted(params: {
    sessionKey: string;
    message?: string;
    now?: number;
  }): ProgressEvent | null {
    const state = this.sessions.get(params.sessionKey);
    if (!state || state.isTerminal) {
      return null;
    }
    const now = params.now ?? Date.now();
    state.lastEventAt = now;
    state.isTerminal = true;
    const elapsedMs = now - state.startedAt;

    return this.emitEvent({
      sessionKey: state.sessionKey,
      agentLabel: state.agentLabel,
      eventType: "COMPLETED",
      message: params.message ?? "Sub-agent completed",
      metrics: { ...state.metrics },
      metadata: {
        durationMs: elapsedMs,
        parentSessionKey: state.parentSessionKey,
      },
      timestamp: now,
    });
  }

  /**
   * Record a failure event.
   */
  onFailed(params: { sessionKey: string; error?: string; now?: number }): ProgressEvent | null {
    const state = this.sessions.get(params.sessionKey);
    if (!state || state.isTerminal) {
      return null;
    }
    const now = params.now ?? Date.now();
    state.lastEventAt = now;
    state.isTerminal = true;
    const elapsedMs = now - state.startedAt;

    return this.emitEvent({
      sessionKey: state.sessionKey,
      agentLabel: state.agentLabel,
      eventType: "FAILED",
      message: params.error ? `Sub-agent failed: ${params.error}` : "Sub-agent failed",
      metrics: { ...state.metrics },
      metadata: {
        error: params.error,
        durationMs: elapsedMs,
        parentSessionKey: state.parentSessionKey,
      },
      timestamp: now,
    });
  }

  // ── Query ───────────────────────────────────────────────────────────

  /**
   * Get the current state of a tracked session.
   */
  getSessionState(sessionKey: string): SessionState | undefined {
    return this.sessions.get(sessionKey);
  }

  /**
   * Get all actively tracked sessions.
   */
  getActiveSessions(): SessionState[] {
    return [...this.sessions.values()].filter((s) => !s.isTerminal);
  }

  /**
   * Get all tracked sessions (including terminal).
   */
  getAllTrackedSessions(): SessionState[] {
    return [...this.sessions.values()];
  }

  /**
   * Get child sessions of a parent.
   */
  getChildSessions(parentSessionKey: string): SessionState[] {
    return [...this.sessions.values()].filter((s) => s.parentSessionKey === parentSessionKey);
  }

  /**
   * Check if a session is being tracked.
   */
  isTracking(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  /**
   * Remove a session from tracking (doesn't delete events).
   */
  stopTracking(sessionKey: string): boolean {
    return this.sessions.delete(sessionKey);
  }

  /**
   * Clear all tracked sessions.
   */
  reset(): void {
    this.sessions.clear();
  }

  // ── Internal ────────────────────────────────────────────────────────

  private emitEvent(params: {
    sessionKey: string;
    agentLabel: string;
    eventType: ProgressEventType;
    message: string;
    metrics: ProgressMetrics;
    metadata?: ProgressEventMetadata;
    timestamp: number;
  }): ProgressEvent {
    const event: ProgressEvent = {
      eventId: randomUUID(),
      timestamp: params.timestamp,
      sessionKey: params.sessionKey,
      agentLabel: params.agentLabel,
      eventType: params.eventType,
      message: params.message,
      metrics: params.metrics,
      metadata: params.metadata,
    };

    // Persist to store (if available)
    if (this.store) {
      try {
        this.store.insertEvent({
          eventId: event.eventId,
          sessionKey: event.sessionKey,
          agentLabel: event.agentLabel,
          eventType: event.eventType,
          message: event.message,
          metrics: event.metrics,
          metadata: event.metadata,
          timestamp: event.timestamp,
        });
      } catch {
        // Don't let store failures break the tracker
      }
    }

    // Emit to stream
    this.stream.emit(event);

    return event;
  }
}

// ── Singleton ───────────────────────────────────────────────────────────

let globalTracker: ProgressTracker | null = null;

/**
 * Get the global progress tracker singleton.
 */
export function getProgressTracker(opts?: {
  store?: ProgressStore | null;
  stream?: ProgressStream;
}): ProgressTracker {
  if (!globalTracker) {
    globalTracker = new ProgressTracker(opts ?? {});
  }
  return globalTracker;
}

/**
 * Reset the global tracker (for testing).
 */
export function resetProgressTracker(): void {
  if (globalTracker) {
    globalTracker.reset();
    globalTracker = null;
  }
}
