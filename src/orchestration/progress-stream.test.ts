/**
 * Tests for Progress Stream API (Hephie Phase 4.1)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ProgressStream, resetProgressStream, getProgressStream } from "./progress-stream.js";
import { createDefaultMetrics, type ProgressEvent } from "./progress-types.js";

function makeEvent(overrides?: Partial<ProgressEvent>): ProgressEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    sessionKey: "agent:main:subagent:test",
    agentLabel: "test-agent",
    eventType: "PROGRESS",
    message: "test event",
    metrics: createDefaultMetrics(),
    ...overrides,
  };
}

describe("ProgressStream", () => {
  let stream: ProgressStream;

  beforeEach(() => {
    stream = new ProgressStream();
  });

  afterEach(() => {
    stream.destroy();
    resetProgressStream();
  });

  // ── Basic Emit/Subscribe ──────────────────────────────────────────

  describe("emit / subscribe", () => {
    it("delivers events to subscribers", () => {
      const received: ProgressEvent[] = [];
      stream.subscribe((e) => received.push(e));

      const event = makeEvent();
      stream.emit(event);

      expect(received).toHaveLength(1);
      expect(received[0].eventId).toBe(event.eventId);
    });

    it("delivers to multiple subscribers", () => {
      const a: ProgressEvent[] = [];
      const b: ProgressEvent[] = [];
      stream.subscribe((e) => a.push(e));
      stream.subscribe((e) => b.push(e));

      stream.emit(makeEvent());
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it("stops delivering after unsubscribe", () => {
      const received: ProgressEvent[] = [];
      const sub = stream.subscribe((e) => received.push(e));

      stream.emit(makeEvent());
      expect(received).toHaveLength(1);

      sub.unsubscribe();
      stream.emit(makeEvent());
      expect(received).toHaveLength(1);
    });
  });

  // ── Filtering ─────────────────────────────────────────────────────

  describe("session key filtering", () => {
    it("only delivers events for matching session key", () => {
      const received: ProgressEvent[] = [];
      stream.subscribe((e) => received.push(e), { sessionKey: "s1" });

      stream.emit(makeEvent({ sessionKey: "s1" }));
      stream.emit(makeEvent({ sessionKey: "s2" }));
      stream.emit(makeEvent({ sessionKey: "s1" }));

      expect(received).toHaveLength(2);
      expect(received.every((e) => e.sessionKey === "s1")).toBe(true);
    });
  });

  describe("event type filtering", () => {
    it("only delivers events of specified types", () => {
      const received: ProgressEvent[] = [];
      stream.subscribe((e) => received.push(e), {
        eventTypes: ["TOOL_CALL", "COMPLETED"],
      });

      stream.emit(makeEvent({ eventType: "SPAWNED" }));
      stream.emit(makeEvent({ eventType: "TOOL_CALL" }));
      stream.emit(makeEvent({ eventType: "THINKING" }));
      stream.emit(makeEvent({ eventType: "COMPLETED" }));

      expect(received).toHaveLength(2);
      expect(received[0].eventType).toBe("TOOL_CALL");
      expect(received[1].eventType).toBe("COMPLETED");
    });
  });

  describe("combined filtering", () => {
    it("filters by both session key and event type", () => {
      const received: ProgressEvent[] = [];
      stream.subscribe((e) => received.push(e), {
        sessionKey: "s1",
        eventTypes: ["TOOL_CALL"],
      });

      stream.emit(makeEvent({ sessionKey: "s1", eventType: "TOOL_CALL" }));
      stream.emit(makeEvent({ sessionKey: "s1", eventType: "SPAWNED" }));
      stream.emit(makeEvent({ sessionKey: "s2", eventType: "TOOL_CALL" }));

      expect(received).toHaveLength(1);
      expect(received[0].sessionKey).toBe("s1");
      expect(received[0].eventType).toBe("TOOL_CALL");
    });
  });

  // ── Batching ──────────────────────────────────────────────────────

  describe("batched subscriptions", () => {
    it("buffers events and delivers at interval", async () => {
      vi.useFakeTimers();

      const received: ProgressEvent[] = [];
      stream.subscribe((e) => received.push(e), {
        batchIntervalMs: 500,
      });

      stream.emit(makeEvent({ eventType: "SPAWNED" }));
      stream.emit(makeEvent({ eventType: "STARTED" }));

      // Events not yet delivered
      expect(received).toHaveLength(0);

      // Advance past batch interval
      vi.advanceTimersByTime(600);

      expect(received).toHaveLength(2);

      vi.useRealTimers();
    });

    it("flushes remaining events on unsubscribe", () => {
      vi.useFakeTimers();

      const received: ProgressEvent[] = [];
      const sub = stream.subscribe((e) => received.push(e), {
        batchIntervalMs: 1000,
      });

      stream.emit(makeEvent());
      stream.emit(makeEvent());

      expect(received).toHaveLength(0);

      sub.unsubscribe();

      // Should flush on unsubscribe
      expect(received).toHaveLength(2);

      vi.useRealTimers();
    });

    it("enforces minimum batch interval", () => {
      vi.useFakeTimers();

      const received: ProgressEvent[] = [];
      stream.subscribe((e) => received.push(e), {
        batchIntervalMs: 10, // Below minimum of 100
      });

      stream.emit(makeEvent());

      // Should still use minimum interval (100ms)
      vi.advanceTimersByTime(50);
      expect(received).toHaveLength(0);

      vi.advanceTimersByTime(100);
      expect(received).toHaveLength(1);

      vi.useRealTimers();
    });
  });

  // ── Batch Subscribe ───────────────────────────────────────────────

  describe("subscribeBatch", () => {
    it("delivers events in batch groups", () => {
      vi.useFakeTimers();

      const batches: ProgressEvent[][] = [];
      stream.subscribeBatch((events) => batches.push(events), {
        batchIntervalMs: 500,
      });

      stream.emit(makeEvent({ eventType: "SPAWNED" }));
      stream.emit(makeEvent({ eventType: "STARTED" }));

      vi.advanceTimersByTime(600);

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(2);

      vi.useRealTimers();
    });

    it("does not deliver empty batches", () => {
      vi.useFakeTimers();

      const batches: ProgressEvent[][] = [];
      stream.subscribeBatch((events) => batches.push(events), {
        batchIntervalMs: 200,
      });

      vi.advanceTimersByTime(500);
      expect(batches).toHaveLength(0);

      vi.useRealTimers();
    });

    it("flushes on unsubscribe", () => {
      vi.useFakeTimers();

      const batches: ProgressEvent[][] = [];
      const sub = stream.subscribeBatch((events) => batches.push(events), {
        batchIntervalMs: 1000,
      });

      stream.emit(makeEvent());
      sub.unsubscribe();

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(1);

      vi.useRealTimers();
    });
  });

  // ── Utility ───────────────────────────────────────────────────────

  describe("listenerCount", () => {
    it("tracks active listeners", () => {
      expect(stream.listenerCount).toBe(0);

      const sub1 = stream.subscribe(() => {});
      expect(stream.listenerCount).toBe(1);

      const sub2 = stream.subscribe(() => {});
      expect(stream.listenerCount).toBe(2);

      sub1.unsubscribe();
      expect(stream.listenerCount).toBe(1);

      sub2.unsubscribe();
      expect(stream.listenerCount).toBe(0);
    });
  });

  describe("destroy", () => {
    it("removes all listeners", () => {
      stream.subscribe(() => {});
      stream.subscribe(() => {});
      expect(stream.listenerCount).toBe(2);

      stream.destroy();
      expect(stream.listenerCount).toBe(0);
    });
  });

  // ── Singleton ─────────────────────────────────────────────────────

  describe("getProgressStream / resetProgressStream", () => {
    it("returns the same instance", () => {
      const a = getProgressStream();
      const b = getProgressStream();
      expect(a).toBe(b);
    });

    it("returns a new instance after reset", () => {
      const a = getProgressStream();
      resetProgressStream();
      const b = getProgressStream();
      expect(a).not.toBe(b);
    });
  });
});
