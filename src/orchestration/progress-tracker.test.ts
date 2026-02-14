/**
 * Tests for Progress Tracker (Hephie Phase 4.1)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ProgressEvent } from "./progress-types.js";
import { ProgressStore, type ProgressDatabase } from "./progress-store.js";
import { ProgressStream, resetProgressStream } from "./progress-stream.js";
import { ProgressTracker, resetProgressTracker, getProgressTracker } from "./progress-tracker.js";

function createTestDb(): ProgressDatabase {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(":memory:");
}

describe("ProgressTracker", () => {
  let store: ProgressStore;
  let stream: ProgressStream;
  let tracker: ProgressTracker;

  beforeEach(() => {
    const db = createTestDb();
    store = new ProgressStore(db);
    stream = new ProgressStream();
    tracker = new ProgressTracker({ store, stream });
  });

  afterEach(() => {
    tracker.reset();
    stream.destroy();
    resetProgressTracker();
    resetProgressStream();
  });

  // ── Spawn ─────────────────────────────────────────────────────────

  describe("onSpawned", () => {
    it("creates a SPAWNED event", () => {
      const event = tracker.onSpawned({
        sessionKey: "agent:main:subagent:abc",
        agentLabel: "build-agent",
        now: 1000,
      });

      expect(event.eventType).toBe("SPAWNED");
      expect(event.sessionKey).toBe("agent:main:subagent:abc");
      expect(event.agentLabel).toBe("build-agent");
      expect(event.timestamp).toBe(1000);
    });

    it("stores parent session key in metadata", () => {
      const event = tracker.onSpawned({
        sessionKey: "child",
        agentLabel: "child-agent",
        parentSessionKey: "parent-session",
        now: 1000,
      });

      expect(event.metadata?.parentSessionKey).toBe("parent-session");
    });

    it("includes task in message", () => {
      const event = tracker.onSpawned({
        sessionKey: "s1",
        agentLabel: "a1",
        task: "Build the thing",
        now: 1000,
      });

      expect(event.message).toContain("Build the thing");
    });

    it("persists event to store", () => {
      tracker.onSpawned({
        sessionKey: "s1",
        agentLabel: "a1",
        now: 1000,
      });

      const events = store.getSessionEvents("s1");
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("SPAWNED");
    });

    it("emits event to stream", () => {
      const received: ProgressEvent[] = [];
      stream.subscribe((e) => received.push(e));

      tracker.onSpawned({
        sessionKey: "s1",
        agentLabel: "a1",
        now: 1000,
      });

      expect(received).toHaveLength(1);
      expect(received[0].eventType).toBe("SPAWNED");
    });

    it("stores model and thinking level in metadata", () => {
      const event = tracker.onSpawned({
        sessionKey: "s1",
        agentLabel: "a1",
        model: "claude-opus-4",
        thinkingLevel: "high",
        now: 1000,
      });

      expect(event.metadata?.model).toBe("claude-opus-4");
      expect(event.metadata?.thinkingLevel).toBe("high");
    });
  });

  // ── Started ───────────────────────────────────────────────────────

  describe("onStarted", () => {
    it("creates a STARTED event for a tracked session", () => {
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      const event = tracker.onStarted({ sessionKey: "s1", now: 1500 });

      expect(event).not.toBeNull();
      expect(event!.eventType).toBe("STARTED");
    });

    it("returns null for untracked session", () => {
      const event = tracker.onStarted({ sessionKey: "unknown", now: 1000 });
      expect(event).toBeNull();
    });

    it("returns null for terminal session", () => {
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      tracker.onCompleted({ sessionKey: "s1", now: 2000 });
      const event = tracker.onStarted({ sessionKey: "s1", now: 3000 });
      expect(event).toBeNull();
    });
  });

  // ── Progress ──────────────────────────────────────────────────────

  describe("onProgress", () => {
    it("creates a PROGRESS event", () => {
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      const event = tracker.onProgress({
        sessionKey: "s1",
        message: "50% done",
        stepsCompleted: 5,
        estimatedRemaining: 5,
        confidence: 0.9,
        now: 2000,
      });

      expect(event).not.toBeNull();
      expect(event!.eventType).toBe("PROGRESS");
      expect(event!.message).toBe("50% done");
      expect(event!.metrics.stepsCompleted).toBe(5);
      expect(event!.metrics.estimatedRemaining).toBe(5);
      expect(event!.metrics.confidence).toBe(0.9);
    });

    it("accumulates progress across calls", () => {
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      tracker.onProgress({ sessionKey: "s1", stepsCompleted: 3, now: 2000 });
      const event = tracker.onProgress({ sessionKey: "s1", stepsCompleted: 7, now: 3000 });
      expect(event!.metrics.stepsCompleted).toBe(7);
    });
  });

  // ── Tool Call ─────────────────────────────────────────────────────

  describe("onToolCall", () => {
    it("creates a TOOL_CALL event", () => {
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      const event = tracker.onToolCall({
        sessionKey: "s1",
        toolName: "exec",
        durationMs: 500,
        now: 2000,
      });

      expect(event).not.toBeNull();
      expect(event!.eventType).toBe("TOOL_CALL");
      expect(event!.metadata?.toolName).toBe("exec");
      expect(event!.metadata?.durationMs).toBe(500);
    });

    it("increments tool call count and steps", () => {
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      tracker.onToolCall({ sessionKey: "s1", toolName: "exec", now: 2000 });
      const event = tracker.onToolCall({ sessionKey: "s1", toolName: "read", now: 3000 });

      expect(event!.metrics.toolCallCount).toBe(2);
      expect(event!.metrics.stepsCompleted).toBe(2);
    });
  });

  // ── Thinking ──────────────────────────────────────────────────────

  describe("onThinking", () => {
    it("creates a THINKING event", () => {
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      const event = tracker.onThinking({
        sessionKey: "s1",
        durationMs: 3000,
        now: 2000,
      });

      expect(event).not.toBeNull();
      expect(event!.eventType).toBe("THINKING");
      expect(event!.metadata?.durationMs).toBe(3000);
    });

    it("increments thinking block count", () => {
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      tracker.onThinking({ sessionKey: "s1", now: 2000 });
      const event = tracker.onThinking({ sessionKey: "s1", now: 3000 });
      expect(event!.metrics.thinkingBlockCount).toBe(2);
    });
  });

  // ── Completed ─────────────────────────────────────────────────────

  describe("onCompleted", () => {
    it("creates a COMPLETED event", () => {
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      const event = tracker.onCompleted({ sessionKey: "s1", now: 5000 });

      expect(event).not.toBeNull();
      expect(event!.eventType).toBe("COMPLETED");
      expect(event!.metadata?.durationMs).toBe(4000); // 5000 - 1000
    });

    it("marks session as terminal", () => {
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      tracker.onCompleted({ sessionKey: "s1", now: 2000 });

      // Subsequent events should be ignored
      const event = tracker.onToolCall({ sessionKey: "s1", toolName: "exec", now: 3000 });
      expect(event).toBeNull();
    });

    it("includes custom message", () => {
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      const event = tracker.onCompleted({
        sessionKey: "s1",
        message: "All tests passed!",
        now: 2000,
      });
      expect(event!.message).toBe("All tests passed!");
    });
  });

  // ── Failed ────────────────────────────────────────────────────────

  describe("onFailed", () => {
    it("creates a FAILED event", () => {
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      const event = tracker.onFailed({
        sessionKey: "s1",
        error: "Out of memory",
        now: 5000,
      });

      expect(event).not.toBeNull();
      expect(event!.eventType).toBe("FAILED");
      expect(event!.metadata?.error).toBe("Out of memory");
      expect(event!.metadata?.durationMs).toBe(4000);
    });

    it("marks session as terminal", () => {
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      tracker.onFailed({ sessionKey: "s1", now: 2000 });

      const event = tracker.onProgress({ sessionKey: "s1", now: 3000 });
      expect(event).toBeNull();
    });
  });

  // ── Session Queries ───────────────────────────────────────────────

  describe("session state queries", () => {
    it("getSessionState returns tracked session", () => {
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      const state = tracker.getSessionState("s1");
      expect(state).toBeDefined();
      expect(state!.sessionKey).toBe("s1");
      expect(state!.agentLabel).toBe("a1");
    });

    it("getSessionState returns undefined for untracked", () => {
      expect(tracker.getSessionState("unknown")).toBeUndefined();
    });

    it("getActiveSessions returns only non-terminal sessions", () => {
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      tracker.onSpawned({ sessionKey: "s2", agentLabel: "a2", now: 1000 });
      tracker.onCompleted({ sessionKey: "s1", now: 2000 });

      const active = tracker.getActiveSessions();
      expect(active).toHaveLength(1);
      expect(active[0].sessionKey).toBe("s2");
    });

    it("getAllTrackedSessions returns all sessions", () => {
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      tracker.onSpawned({ sessionKey: "s2", agentLabel: "a2", now: 1000 });
      tracker.onCompleted({ sessionKey: "s1", now: 2000 });

      expect(tracker.getAllTrackedSessions()).toHaveLength(2);
    });

    it("getChildSessions returns children of parent", () => {
      tracker.onSpawned({ sessionKey: "parent", agentLabel: "main", now: 1000 });
      tracker.onSpawned({
        sessionKey: "child1",
        agentLabel: "worker1",
        parentSessionKey: "parent",
        now: 1000,
      });
      tracker.onSpawned({
        sessionKey: "child2",
        agentLabel: "worker2",
        parentSessionKey: "parent",
        now: 1000,
      });
      tracker.onSpawned({
        sessionKey: "other",
        agentLabel: "other",
        parentSessionKey: "different",
        now: 1000,
      });

      const children = tracker.getChildSessions("parent");
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.sessionKey).toSorted()).toEqual(["child1", "child2"]);
    });
  });

  // ── Tracking Control ──────────────────────────────────────────────

  describe("tracking control", () => {
    it("isTracking returns correct state", () => {
      expect(tracker.isTracking("s1")).toBe(false);
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      expect(tracker.isTracking("s1")).toBe(true);
    });

    it("stopTracking removes a session", () => {
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      expect(tracker.stopTracking("s1")).toBe(true);
      expect(tracker.isTracking("s1")).toBe(false);
    });

    it("stopTracking returns false for untracked", () => {
      expect(tracker.stopTracking("unknown")).toBe(false);
    });

    it("reset clears all sessions", () => {
      tracker.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      tracker.onSpawned({ sessionKey: "s2", agentLabel: "a2", now: 1000 });
      tracker.reset();
      expect(tracker.getAllTrackedSessions()).toHaveLength(0);
    });
  });

  // ── Store-less Operation ──────────────────────────────────────────

  describe("without store", () => {
    it("works without a store (stream-only)", () => {
      const received: ProgressEvent[] = [];
      const storeless = new ProgressTracker({ store: null, stream });
      stream.subscribe((e) => received.push(e));

      storeless.onSpawned({ sessionKey: "s1", agentLabel: "a1", now: 1000 });
      expect(received).toHaveLength(1);
      // Store should have no events
      expect(store.getEventCount()).toBe(0);
    });
  });

  // ── Full Lifecycle ────────────────────────────────────────────────

  describe("full lifecycle", () => {
    it("tracks a complete sub-agent lifecycle", () => {
      const received: ProgressEvent[] = [];
      stream.subscribe((e) => received.push(e));

      tracker.onSpawned({
        sessionKey: "s1",
        agentLabel: "phase4-builder",
        parentSessionKey: "main",
        task: "Build phase 4",
        now: 1000,
      });
      tracker.onStarted({ sessionKey: "s1", now: 1100 });
      tracker.onToolCall({ sessionKey: "s1", toolName: "read", now: 1200 });
      tracker.onThinking({ sessionKey: "s1", now: 1300 });
      tracker.onToolCall({ sessionKey: "s1", toolName: "write", now: 1400 });
      tracker.onProgress({ sessionKey: "s1", stepsCompleted: 5, now: 1500 });
      tracker.onToolCall({ sessionKey: "s1", toolName: "exec", now: 1600 });
      tracker.onCompleted({ sessionKey: "s1", now: 2000 });

      // Stream received all events
      expect(received).toHaveLength(8);

      // Store has all events
      const events = store.getSessionEvents("s1");
      expect(events).toHaveLength(8);

      // Final metrics
      const last = events[events.length - 1];
      expect(last.eventType).toBe("COMPLETED");
      expect(last.metrics.toolCallCount).toBe(3);
      expect(last.metrics.thinkingBlockCount).toBe(1);
      expect(last.metrics.stepsCompleted).toBe(6); // 2 tool calls before progress(5) + 1 after = 6

      // Aggregate
      const agg = store.getAggregateMetrics("s1");
      expect(agg.completionPercent).toBe(100);
      expect(agg.uniqueTools).toEqual(["exec", "read", "write"]);
    });
  });

  // ── Singleton ─────────────────────────────────────────────────────

  describe("getProgressTracker / resetProgressTracker", () => {
    it("returns the same instance", () => {
      resetProgressTracker();
      const a = getProgressTracker();
      const b = getProgressTracker();
      expect(a).toBe(b);
    });

    it("returns a new instance after reset", () => {
      resetProgressTracker();
      const a = getProgressTracker();
      resetProgressTracker();
      const b = getProgressTracker();
      expect(a).not.toBe(b);
    });
  });
});
