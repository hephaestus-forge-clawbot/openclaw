/**
 * Tests for Progress Store (Hephie Phase 4.1)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ProgressStore, type ProgressDatabase } from "./progress-store.js";

/**
 * In-memory SQLite database for testing.
 */
function createTestDb(): ProgressDatabase {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  return db;
}

describe("ProgressStore", () => {
  let db: ProgressDatabase;
  let store: ProgressStore;

  beforeEach(() => {
    db = createTestDb();
    store = new ProgressStore(db);
  });

  // ── Schema ──────────────────────────────────────────────────────────

  describe("Schema", () => {
    it("creates the progress_events table", () => {
      const rows = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='progress_events'`)
        .all() as Array<{ name: string }>;
      expect(rows).toHaveLength(1);
    });

    it("creates expected indexes", () => {
      const rows = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_pe_%'`)
        .all() as Array<{ name: string }>;
      expect(rows.length).toBeGreaterThanOrEqual(4);
    });

    it("idempotent schema creation", () => {
      // Creating a second store on the same db should not throw
      const store2 = new ProgressStore(db);
      expect(store2).toBeDefined();
    });
  });

  // ── Insert & Get ────────────────────────────────────────────────────

  describe("insertEvent / getEvent", () => {
    it("inserts and retrieves an event", () => {
      const event = store.insertEvent({
        sessionKey: "agent:main:subagent:abc",
        agentLabel: "test-agent",
        eventType: "SPAWNED",
        message: "Agent spawned",
        timestamp: 1000,
      });

      expect(event.eventId).toBeDefined();
      expect(event.sessionKey).toBe("agent:main:subagent:abc");
      expect(event.agentLabel).toBe("test-agent");
      expect(event.eventType).toBe("SPAWNED");
      expect(event.message).toBe("Agent spawned");
      expect(event.timestamp).toBe(1000);

      const fetched = store.getEvent(event.eventId);
      expect(fetched).toBeDefined();
      expect(fetched!.eventId).toBe(event.eventId);
      expect(fetched!.sessionKey).toBe("agent:main:subagent:abc");
    });

    it("returns null for non-existent event", () => {
      expect(store.getEvent("non-existent")).toBeNull();
    });

    it("stores metrics correctly", () => {
      const event = store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "PROGRESS",
        metrics: {
          stepsCompleted: 5,
          estimatedRemaining: 10,
          confidence: 0.8,
          toolCallCount: 3,
          thinkingBlockCount: 2,
        },
        timestamp: 1000,
      });

      const fetched = store.getEvent(event.eventId)!;
      expect(fetched.metrics.stepsCompleted).toBe(5);
      expect(fetched.metrics.estimatedRemaining).toBe(10);
      expect(fetched.metrics.confidence).toBe(0.8);
      expect(fetched.metrics.toolCallCount).toBe(3);
      expect(fetched.metrics.thinkingBlockCount).toBe(2);
    });

    it("stores metadata as JSON", () => {
      const event = store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "TOOL_CALL",
        metadata: { toolName: "exec", durationMs: 500 },
        timestamp: 1000,
      });

      const fetched = store.getEvent(event.eventId)!;
      expect(fetched.metadata?.toolName).toBe("exec");
      expect(fetched.metadata?.durationMs).toBe(500);
    });

    it("uses custom event ID if provided", () => {
      const event = store.insertEvent({
        eventId: "custom-id",
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      expect(event.eventId).toBe("custom-id");
    });

    it("defaults message to empty string", () => {
      const event = store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      expect(event.message).toBe("");
    });
  });

  // ── Latest Event ────────────────────────────────────────────────────

  describe("getLatestEvent", () => {
    it("returns the latest event for a session", () => {
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "STARTED",
        timestamp: 2000,
      });
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "COMPLETED",
        timestamp: 3000,
      });

      const latest = store.getLatestEvent("s1");
      expect(latest).toBeDefined();
      expect(latest!.eventType).toBe("COMPLETED");
      expect(latest!.timestamp).toBe(3000);
    });

    it("returns null for non-existent session", () => {
      expect(store.getLatestEvent("non-existent")).toBeNull();
    });
  });

  // ── Query ───────────────────────────────────────────────────────────

  describe("queryEvents", () => {
    beforeEach(() => {
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "build-agent",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "build-agent",
        eventType: "TOOL_CALL",
        timestamp: 2000,
        metadata: { toolName: "exec" },
      });
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "build-agent",
        eventType: "COMPLETED",
        timestamp: 3000,
      });
      store.insertEvent({
        sessionKey: "s2",
        agentLabel: "test-agent",
        eventType: "SPAWNED",
        timestamp: 1500,
      });
      store.insertEvent({
        sessionKey: "s2",
        agentLabel: "test-agent",
        eventType: "FAILED",
        timestamp: 4000,
        metadata: { error: "timeout" },
      });
    });

    it("queries all events", () => {
      const events = store.queryEvents({});
      expect(events).toHaveLength(5);
    });

    it("filters by session key", () => {
      const events = store.queryEvents({ sessionKey: "s1" });
      expect(events).toHaveLength(3);
      expect(events.every((e) => e.sessionKey === "s1")).toBe(true);
    });

    it("filters by agent label (LIKE)", () => {
      const events = store.queryEvents({ agentLabel: "build" });
      expect(events).toHaveLength(3);
    });

    it("filters by event types", () => {
      const events = store.queryEvents({ eventTypes: ["SPAWNED"] });
      expect(events).toHaveLength(2);
    });

    it("filters by multiple event types", () => {
      const events = store.queryEvents({ eventTypes: ["COMPLETED", "FAILED"] });
      expect(events).toHaveLength(2);
    });

    it("filters by time range (since)", () => {
      const events = store.queryEvents({ since: 2000 });
      expect(events).toHaveLength(3);
    });

    it("filters by time range (until)", () => {
      const events = store.queryEvents({ until: 2000 });
      expect(events).toHaveLength(3);
    });

    it("supports limit and offset", () => {
      const events = store.queryEvents({ limit: 2, offset: 1 });
      expect(events).toHaveLength(2);
    });

    it("supports descending order", () => {
      const events = store.queryEvents({ order: "desc" });
      expect(events[0].timestamp).toBe(4000);
    });

    it("combines multiple filters", () => {
      const events = store.queryEvents({
        sessionKey: "s1",
        eventTypes: ["TOOL_CALL"],
        since: 1500,
      });
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("TOOL_CALL");
    });
  });

  // ── Session Queries ─────────────────────────────────────────────────

  describe("getSessionEvents", () => {
    it("returns events in chronological order", () => {
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "COMPLETED",
        timestamp: 3000,
      });
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "STARTED",
        timestamp: 2000,
      });

      const events = store.getSessionEvents("s1");
      expect(events[0].timestamp).toBe(1000);
      expect(events[1].timestamp).toBe(2000);
      expect(events[2].timestamp).toBe(3000);
    });
  });

  describe("getActiveSessions", () => {
    it("returns sessions without terminal events", () => {
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "COMPLETED",
        timestamp: 2000,
      });
      store.insertEvent({
        sessionKey: "s2",
        agentLabel: "a2",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      store.insertEvent({
        sessionKey: "s3",
        agentLabel: "a3",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      store.insertEvent({
        sessionKey: "s3",
        agentLabel: "a3",
        eventType: "FAILED",
        timestamp: 2000,
      });

      const active = store.getActiveSessions();
      expect(active).toEqual(["s2"]);
    });

    it("returns empty array when all sessions are terminal", () => {
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "COMPLETED",
        timestamp: 1000,
      });
      expect(store.getActiveSessions()).toEqual([]);
    });
  });

  describe("getAllSessions", () => {
    it("returns all unique session keys", () => {
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      store.insertEvent({
        sessionKey: "s2",
        agentLabel: "a2",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "COMPLETED",
        timestamp: 2000,
      });

      const sessions = store.getAllSessions();
      expect(sessions).toEqual(["s1", "s2"]);
    });
  });

  // ── Delete ──────────────────────────────────────────────────────────

  describe("deleteSessionEvents", () => {
    it("deletes all events for a session", () => {
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "COMPLETED",
        timestamp: 2000,
      });
      store.insertEvent({
        sessionKey: "s2",
        agentLabel: "a2",
        eventType: "SPAWNED",
        timestamp: 1000,
      });

      const deleted = store.deleteSessionEvents("s1");
      expect(deleted).toBe(2);
      expect(store.getEventCount("s1")).toBe(0);
      expect(store.getEventCount("s2")).toBe(1);
    });
  });

  describe("deleteEventsOlderThan", () => {
    it("deletes events before a timestamp", () => {
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "STARTED",
        timestamp: 2000,
      });
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "COMPLETED",
        timestamp: 3000,
      });

      const deleted = store.deleteEventsOlderThan(2500);
      expect(deleted).toBe(2);
      expect(store.getEventCount()).toBe(1);
    });
  });

  describe("deleteEvent", () => {
    it("deletes a specific event", () => {
      const event = store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      expect(store.deleteEvent(event.eventId)).toBe(true);
      expect(store.getEvent(event.eventId)).toBeNull();
    });

    it("returns false for non-existent event", () => {
      expect(store.deleteEvent("non-existent")).toBe(false);
    });
  });

  // ── Aggregates ──────────────────────────────────────────────────────

  describe("getAggregateMetrics", () => {
    beforeEach(() => {
      // s1: completed
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "build",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "build",
        eventType: "TOOL_CALL",
        timestamp: 2000,
        metadata: { toolName: "exec" },
        metrics: { stepsCompleted: 1, toolCallCount: 1, thinkingBlockCount: 0 },
      });
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "build",
        eventType: "TOOL_CALL",
        timestamp: 3000,
        metadata: { toolName: "read" },
        metrics: { stepsCompleted: 2, toolCallCount: 2, thinkingBlockCount: 0 },
      });
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "build",
        eventType: "COMPLETED",
        timestamp: 4000,
        metrics: { stepsCompleted: 3, toolCallCount: 2, thinkingBlockCount: 1 },
      });

      // s2: failed
      store.insertEvent({
        sessionKey: "s2",
        agentLabel: "test",
        eventType: "SPAWNED",
        timestamp: 1500,
      });
      store.insertEvent({
        sessionKey: "s2",
        agentLabel: "test",
        eventType: "FAILED",
        timestamp: 2500,
        metadata: { error: "crash" },
      });

      // s3: active
      store.insertEvent({
        sessionKey: "s3",
        agentLabel: "deploy",
        eventType: "SPAWNED",
        timestamp: 2000,
      });
      store.insertEvent({
        sessionKey: "s3",
        agentLabel: "deploy",
        eventType: "PROGRESS",
        timestamp: 3500,
      });
    });

    it("computes global aggregate metrics", () => {
      const agg = store.getAggregateMetrics();
      expect(agg.totalEvents).toBe(8);
      expect(agg.completedSessions).toBe(1);
      expect(agg.failedSessions).toBe(1);
      expect(agg.activeSessions).toBe(1);
    });

    it("computes per-session metrics", () => {
      const agg = store.getAggregateMetrics("s1");
      expect(agg.eventsByType.SPAWNED).toBe(1);
      expect(agg.eventsByType.TOOL_CALL).toBe(2);
      expect(agg.eventsByType.COMPLETED).toBe(1);
      expect(agg.completionPercent).toBe(100);
      expect(agg.elapsedMs).toBe(3000); // 4000 - 1000
    });

    it("identifies unique tools", () => {
      const agg = store.getAggregateMetrics();
      expect(agg.uniqueTools).toContain("exec");
      expect(agg.uniqueTools).toContain("read");
    });

    it("handles empty store", () => {
      const emptyStore = new ProgressStore(createTestDb());
      const agg = emptyStore.getAggregateMetrics();
      expect(agg.totalEvents).toBe(0);
      expect(agg.completionPercent).toBe(0);
    });

    it("completion percent is correct", () => {
      const agg = store.getAggregateMetrics();
      // 2 out of 3 sessions are terminal
      expect(agg.completionPercent).toBe(67); // Math.round(2/3 * 100)
    });
  });

  // ── Event Count ─────────────────────────────────────────────────────

  describe("getEventCount", () => {
    it("counts all events", () => {
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      store.insertEvent({
        sessionKey: "s2",
        agentLabel: "a2",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      expect(store.getEventCount()).toBe(2);
    });

    it("counts events per session", () => {
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "a1",
        eventType: "COMPLETED",
        timestamp: 2000,
      });
      store.insertEvent({
        sessionKey: "s2",
        agentLabel: "a2",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      expect(store.getEventCount("s1")).toBe(2);
      expect(store.getEventCount("s2")).toBe(1);
    });

    it("returns 0 for empty store", () => {
      expect(store.getEventCount()).toBe(0);
    });
  });
});
