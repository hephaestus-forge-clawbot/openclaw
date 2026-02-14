/**
 * Tests for Progress CLI Command (Hephie Phase 4.1)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  formatTimestamp,
  formatDuration,
  formatEvent,
  formatSessionSummary,
  formatActiveSessions,
  formatSummary,
  executeProgressCommand,
} from "./progress-command.js";
import { ProgressStore, type ProgressDatabase } from "./progress-store.js";
import {
  createDefaultMetrics,
  type ProgressEvent,
  type AggregateMetrics,
} from "./progress-types.js";

function createTestDb(): ProgressDatabase {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(":memory:");
}

function makeEvent(overrides?: Partial<ProgressEvent>): ProgressEvent {
  return {
    eventId: "evt-1",
    timestamp: 1700000000000,
    sessionKey: "agent:main:subagent:abc",
    agentLabel: "test-agent",
    eventType: "PROGRESS",
    message: "test message",
    metrics: createDefaultMetrics(),
    ...overrides,
  };
}

describe("Progress Command", () => {
  // ── Formatting Utilities ──────────────────────────────────────────

  describe("formatTimestamp", () => {
    it("formats a timestamp as ISO string without timezone", () => {
      const result = formatTimestamp(1700000000000);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    });
  });

  describe("formatDuration", () => {
    it("formats milliseconds", () => {
      expect(formatDuration(500)).toBe("500ms");
    });

    it("formats seconds", () => {
      expect(formatDuration(5000)).toBe("5s");
    });

    it("formats minutes and seconds", () => {
      expect(formatDuration(125000)).toBe("2m 5s");
    });

    it("formats hours and minutes", () => {
      expect(formatDuration(7500000)).toBe("2h 5m");
    });

    it("formats zero", () => {
      expect(formatDuration(0)).toBe("0ms");
    });
  });

  // ── Event Formatting ──────────────────────────────────────────────

  describe("formatEvent", () => {
    it("includes emoji for event type", () => {
      const result = formatEvent(makeEvent({ eventType: "SPAWNED" }));
      expect(result).toContain("🥚");
    });

    it("includes event type name", () => {
      const result = formatEvent(makeEvent({ eventType: "TOOL_CALL" }));
      expect(result).toContain("TOOL_CALL");
    });

    it("includes agent label", () => {
      const result = formatEvent(makeEvent({ agentLabel: "my-agent" }));
      expect(result).toContain("my-agent");
    });

    it("includes message", () => {
      const result = formatEvent(makeEvent({ message: "Building phase 4" }));
      expect(result).toContain("Building phase 4");
    });

    it("includes step count", () => {
      const result = formatEvent(
        makeEvent({
          metrics: { stepsCompleted: 5, toolCallCount: 3, thinkingBlockCount: 1 },
        }),
      );
      expect(result).toContain("5 steps");
      expect(result).toContain("3 tools");
    });
  });

  // ── Session Summary ───────────────────────────────────────────────

  describe("formatSessionSummary", () => {
    it("returns no events message for empty list", () => {
      expect(formatSessionSummary([])).toBe("No events recorded.");
    });

    it("formats a session summary", () => {
      const events = [
        makeEvent({ eventType: "SPAWNED", timestamp: 1000 }),
        makeEvent({ eventType: "STARTED", timestamp: 2000 }),
        makeEvent({
          eventType: "COMPLETED",
          timestamp: 5000,
          metrics: { stepsCompleted: 10, toolCallCount: 5, thinkingBlockCount: 3 },
        }),
      ];

      const result = formatSessionSummary(events);
      expect(result).toContain("Session:");
      expect(result).toContain("Agent:");
      expect(result).toContain("COMPLETED");
      expect(result).toContain("Events:");
    });

    it("shows ACTIVE status for non-terminal sessions", () => {
      const events = [
        makeEvent({ eventType: "SPAWNED", timestamp: 1000 }),
        makeEvent({ eventType: "PROGRESS", timestamp: 2000 }),
      ];

      const result = formatSessionSummary(events);
      expect(result).toContain("ACTIVE");
    });
  });

  // ── Active Sessions ───────────────────────────────────────────────

  describe("formatActiveSessions", () => {
    it("returns no active message for empty list", () => {
      expect(formatActiveSessions([])).toBe("No active sub-agents.");
    });

    it("formats active sessions", () => {
      const sessions = [
        {
          sessionKey: "s1",
          events: [
            makeEvent({ agentLabel: "builder", eventType: "SPAWNED", timestamp: 1000 }),
            makeEvent({
              agentLabel: "builder",
              eventType: "PROGRESS",
              timestamp: 2000,
              metrics: { stepsCompleted: 3, toolCallCount: 2, thinkingBlockCount: 0 },
            }),
          ],
        },
      ];

      const result = formatActiveSessions(sessions);
      expect(result).toContain("Active Sub-Agents: 1");
      expect(result).toContain("builder");
    });
  });

  // ── Summary ───────────────────────────────────────────────────────

  describe("formatSummary", () => {
    it("formats aggregate metrics", () => {
      const metrics: AggregateMetrics = {
        totalEvents: 42,
        eventsByType: {
          SPAWNED: 5,
          STARTED: 5,
          PROGRESS: 10,
          TOOL_CALL: 15,
          THINKING: 3,
          COMPLETED: 3,
          FAILED: 1,
        },
        completionPercent: 80,
        elapsedMs: 300000,
        totalToolCalls: 15,
        uniqueTools: ["exec", "read", "write"],
        activeSessions: 1,
        completedSessions: 3,
        failedSessions: 1,
      };

      const result = formatSummary(metrics);
      expect(result).toContain("Sub-Agent Progress Summary");
      expect(result).toContain("42");
      expect(result).toContain("80%");
      expect(result).toContain("exec, read, write");
    });
  });

  // ── Command Execution ─────────────────────────────────────────────

  describe("executeProgressCommand", () => {
    let store: ProgressStore;

    beforeEach(() => {
      store = new ProgressStore(createTestDb());
      // Seed with data
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "builder",
        eventType: "SPAWNED",
        timestamp: 1000,
      });
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "builder",
        eventType: "TOOL_CALL",
        timestamp: 2000,
        metadata: { toolName: "exec" },
      });
      store.insertEvent({
        sessionKey: "s1",
        agentLabel: "builder",
        eventType: "COMPLETED",
        timestamp: 3000,
      });
      store.insertEvent({
        sessionKey: "s2",
        agentLabel: "tester",
        eventType: "SPAWNED",
        timestamp: 1500,
      });
      store.insertEvent({
        sessionKey: "s2",
        agentLabel: "tester",
        eventType: "PROGRESS",
        timestamp: 2500,
      });
    });

    it("--session shows session progress", () => {
      const result = executeProgressCommand(store, { session: "s1" });
      expect(result).toContain("Session: s1");
      expect(result).toContain("builder");
      expect(result).toContain("COMPLETED");
    });

    it("--session with unknown session shows no events", () => {
      const result = executeProgressCommand(store, { session: "unknown" });
      expect(result).toBe("No events recorded.");
    });

    it("--active shows active sessions", () => {
      const result = executeProgressCommand(store, { active: true });
      expect(result).toContain("Active Sub-Agents:");
      expect(result).toContain("tester");
    });

    it("--summary shows aggregated stats", () => {
      const result = executeProgressCommand(store, { summary: true });
      expect(result).toContain("Sub-Agent Progress Summary");
      expect(result).toContain("Total Events:");
    });

    it("--watch shows current state (sync fallback)", () => {
      const result = executeProgressCommand(store, { watch: "s1" });
      expect(result).toContain("Session: s1");
    });

    it("default shows summary", () => {
      const result = executeProgressCommand(store, {});
      expect(result).toContain("Sub-Agent Progress Summary");
    });
  });
});
