/**
 * Progress Stream API (Hephie Phase 4.1)
 *
 * Real-time event streaming for sub-agent progress observability.
 * Uses EventEmitter for pub/sub with support for filtering,
 * batching, and session-specific subscriptions.
 */

import { EventEmitter } from "node:events";
import type {
  ProgressEvent,
  ProgressEventType,
  ProgressSubscriptionOptions,
} from "./progress-types.js";

// ── Stream Events ───────────────────────────────────────────────────────

/**
 * Callback signature for progress event listeners.
 */
export type ProgressEventListener = (event: ProgressEvent) => void;

/**
 * Callback signature for batched progress event listeners.
 */
export type ProgressBatchListener = (events: ProgressEvent[]) => void;

/**
 * Subscription handle returned when subscribing to the progress stream.
 * Call `unsubscribe()` to stop receiving events.
 */
export interface ProgressSubscription {
  /** Stop receiving events. */
  unsubscribe: () => void;
}

// ── Progress Stream ─────────────────────────────────────────────────────

const STREAM_EVENT = "progress";
const BATCH_MIN_INTERVAL_MS = 100;
const DEFAULT_MAX_LISTENERS = 100;

/**
 * Real-time progress event stream.
 *
 * Provides pub/sub for progress events with support for:
 * - Global subscriptions (all events)
 * - Session-specific subscriptions
 * - Event type filtering
 * - Batched delivery (configurable interval)
 */
export class ProgressStream {
  private readonly emitter: EventEmitter;
  private readonly batchTimers = new Map<symbol, NodeJS.Timeout>();
  private readonly batchBuffers = new Map<symbol, ProgressEvent[]>();

  constructor(opts?: { maxListeners?: number }) {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(opts?.maxListeners ?? DEFAULT_MAX_LISTENERS);
  }

  // ── Emit ────────────────────────────────────────────────────────────

  /**
   * Emit a progress event to all matching subscribers.
   */
  emit(event: ProgressEvent): void {
    this.emitter.emit(STREAM_EVENT, event);
  }

  // ── Subscribe ───────────────────────────────────────────────────────

  /**
   * Subscribe to progress events.
   *
   * @param listener - Callback invoked for each matching event.
   * @param options - Optional filters (session key, event types).
   * @returns Subscription handle with `unsubscribe()` method.
   */
  subscribe(
    listener: ProgressEventListener,
    options?: ProgressSubscriptionOptions,
  ): ProgressSubscription {
    const batchInterval = options?.batchIntervalMs ?? 0;

    if (batchInterval > 0) {
      return this.subscribeBatched(listener, options!, batchInterval);
    }

    const filteredListener = this.createFilteredListener(listener, options);
    this.emitter.on(STREAM_EVENT, filteredListener);

    return {
      unsubscribe: () => {
        this.emitter.off(STREAM_EVENT, filteredListener);
      },
    };
  }

  /**
   * Subscribe with batched delivery.
   * Events are buffered and delivered at the specified interval.
   */
  private subscribeBatched(
    listener: ProgressEventListener,
    options: ProgressSubscriptionOptions,
    intervalMs: number,
  ): ProgressSubscription {
    const batchKey = Symbol("batch");
    const effectiveInterval = Math.max(BATCH_MIN_INTERVAL_MS, intervalMs);
    this.batchBuffers.set(batchKey, []);

    const filteredListener = this.createFilteredListener((event) => {
      const buffer = this.batchBuffers.get(batchKey);
      if (buffer) {
        buffer.push(event);
      }
    }, options);

    const timer = setInterval(() => {
      const buffer = this.batchBuffers.get(batchKey);
      if (!buffer || buffer.length === 0) {
        return;
      }
      const events = buffer.splice(0, buffer.length);
      for (const evt of events) {
        listener(evt);
      }
    }, effectiveInterval);
    timer.unref?.();

    this.batchTimers.set(batchKey, timer);
    this.emitter.on(STREAM_EVENT, filteredListener);

    return {
      unsubscribe: () => {
        this.emitter.off(STREAM_EVENT, filteredListener);
        const t = this.batchTimers.get(batchKey);
        if (t) {
          clearInterval(t);
          this.batchTimers.delete(batchKey);
        }
        // Flush remaining buffered events
        const remaining = this.batchBuffers.get(batchKey);
        if (remaining && remaining.length > 0) {
          for (const evt of remaining) {
            listener(evt);
          }
        }
        this.batchBuffers.delete(batchKey);
      },
    };
  }

  /**
   * Subscribe to batched event groups.
   */
  subscribeBatch(
    listener: ProgressBatchListener,
    options?: ProgressSubscriptionOptions & { batchIntervalMs: number },
  ): ProgressSubscription {
    const batchKey = Symbol("batch-group");
    const intervalMs = Math.max(BATCH_MIN_INTERVAL_MS, options?.batchIntervalMs ?? 1000);
    this.batchBuffers.set(batchKey, []);

    const filteredListener = this.createFilteredListener((event) => {
      const buffer = this.batchBuffers.get(batchKey);
      if (buffer) {
        buffer.push(event);
      }
    }, options);

    const timer = setInterval(() => {
      const buffer = this.batchBuffers.get(batchKey);
      if (!buffer || buffer.length === 0) {
        return;
      }
      const events = buffer.splice(0, buffer.length);
      listener(events);
    }, intervalMs);
    timer.unref?.();

    this.batchTimers.set(batchKey, timer);
    this.emitter.on(STREAM_EVENT, filteredListener);

    return {
      unsubscribe: () => {
        this.emitter.off(STREAM_EVENT, filteredListener);
        const t = this.batchTimers.get(batchKey);
        if (t) {
          clearInterval(t);
          this.batchTimers.delete(batchKey);
        }
        // Flush remaining
        const remaining = this.batchBuffers.get(batchKey);
        if (remaining && remaining.length > 0) {
          listener(remaining);
        }
        this.batchBuffers.delete(batchKey);
      },
    };
  }

  // ── Utility ─────────────────────────────────────────────────────────

  /**
   * Get the number of active listeners.
   */
  get listenerCount(): number {
    return this.emitter.listenerCount(STREAM_EVENT);
  }

  /**
   * Remove all listeners and clear all batch timers.
   */
  destroy(): void {
    this.emitter.removeAllListeners(STREAM_EVENT);
    for (const timer of this.batchTimers.values()) {
      clearInterval(timer);
    }
    this.batchTimers.clear();
    this.batchBuffers.clear();
  }

  // ── Internal ────────────────────────────────────────────────────────

  private createFilteredListener(
    listener: ProgressEventListener,
    options?: ProgressSubscriptionOptions,
  ): ProgressEventListener {
    if (!options?.sessionKey && (!options?.eventTypes || options.eventTypes.length === 0)) {
      return listener;
    }

    const sessionKey = options?.sessionKey;
    const eventTypeSet: Set<ProgressEventType> | undefined =
      options?.eventTypes && options.eventTypes.length > 0
        ? new Set(options.eventTypes)
        : undefined;

    return (event: ProgressEvent) => {
      if (sessionKey && event.sessionKey !== sessionKey) {
        return;
      }
      if (eventTypeSet && !eventTypeSet.has(event.eventType)) {
        return;
      }
      listener(event);
    };
  }
}

// ── Singleton ───────────────────────────────────────────────────────────

let globalStream: ProgressStream | null = null;

/**
 * Get the global progress stream singleton.
 */
export function getProgressStream(): ProgressStream {
  if (!globalStream) {
    globalStream = new ProgressStream();
  }
  return globalStream;
}

/**
 * Reset the global stream (for testing).
 */
export function resetProgressStream(): void {
  if (globalStream) {
    globalStream.destroy();
    globalStream = null;
  }
}
