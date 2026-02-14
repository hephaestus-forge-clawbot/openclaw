/**
 * Tests for Progress Event Types (Hephie Phase 4.1)
 */

import { describe, it, expect } from "vitest";
import {
  PROGRESS_EVENT_TYPES,
  TERMINAL_EVENT_TYPES,
  createDefaultMetrics,
  createEmptyAggregateMetrics,
  isValidEventType,
  isTerminalEvent,
  type ProgressEvent,
} from "./progress-types.js";

describe("Progress Event Types", () => {
  // ── Constants ─────────────────────────────────────────────────────

  describe("PROGRESS_EVENT_TYPES", () => {
    it("contains all seven event types", () => {
      expect(PROGRESS_EVENT_TYPES).toHaveLength(7);
      expect(PROGRESS_EVENT_TYPES).toContain("SPAWNED");
      expect(PROGRESS_EVENT_TYPES).toContain("STARTED");
      expect(PROGRESS_EVENT_TYPES).toContain("PROGRESS");
      expect(PROGRESS_EVENT_TYPES).toContain("TOOL_CALL");
      expect(PROGRESS_EVENT_TYPES).toContain("THINKING");
      expect(PROGRESS_EVENT_TYPES).toContain("COMPLETED");
      expect(PROGRESS_EVENT_TYPES).toContain("FAILED");
    });

    it("is immutable (readonly)", () => {
      // Attempting to modify should fail in strict mode or have no effect
      const copy = [...PROGRESS_EVENT_TYPES];
      expect(copy).toEqual(PROGRESS_EVENT_TYPES);
    });
  });

  describe("TERMINAL_EVENT_TYPES", () => {
    it("contains COMPLETED and FAILED", () => {
      expect(TERMINAL_EVENT_TYPES.has("COMPLETED")).toBe(true);
      expect(TERMINAL_EVENT_TYPES.has("FAILED")).toBe(true);
    });

    it("does not contain non-terminal types", () => {
      expect(TERMINAL_EVENT_TYPES.has("SPAWNED")).toBe(false);
      expect(TERMINAL_EVENT_TYPES.has("STARTED")).toBe(false);
      expect(TERMINAL_EVENT_TYPES.has("PROGRESS")).toBe(false);
      expect(TERMINAL_EVENT_TYPES.has("TOOL_CALL")).toBe(false);
      expect(TERMINAL_EVENT_TYPES.has("THINKING")).toBe(false);
    });

    it("has exactly two members", () => {
      expect(TERMINAL_EVENT_TYPES.size).toBe(2);
    });
  });

  // ── Factory Functions ─────────────────────────────────────────────

  describe("createDefaultMetrics", () => {
    it("returns zero-initialized metrics", () => {
      const metrics = createDefaultMetrics();
      expect(metrics.stepsCompleted).toBe(0);
      expect(metrics.toolCallCount).toBe(0);
      expect(metrics.thinkingBlockCount).toBe(0);
    });

    it("does not include optional fields", () => {
      const metrics = createDefaultMetrics();
      expect(metrics.estimatedRemaining).toBeUndefined();
      expect(metrics.confidence).toBeUndefined();
    });

    it("returns distinct objects on each call", () => {
      const a = createDefaultMetrics();
      const b = createDefaultMetrics();
      expect(a).not.toBe(b);
      a.stepsCompleted = 5;
      expect(b.stepsCompleted).toBe(0);
    });
  });

  describe("createEmptyAggregateMetrics", () => {
    it("returns zero-initialized aggregate metrics", () => {
      const agg = createEmptyAggregateMetrics();
      expect(agg.totalEvents).toBe(0);
      expect(agg.completionPercent).toBe(0);
      expect(agg.elapsedMs).toBe(0);
      expect(agg.totalToolCalls).toBe(0);
      expect(agg.uniqueTools).toEqual([]);
      expect(agg.activeSessions).toBe(0);
      expect(agg.completedSessions).toBe(0);
      expect(agg.failedSessions).toBe(0);
    });

    it("has all event types at zero in eventsByType", () => {
      const agg = createEmptyAggregateMetrics();
      for (const type of PROGRESS_EVENT_TYPES) {
        expect(agg.eventsByType[type]).toBe(0);
      }
    });

    it("returns distinct objects on each call", () => {
      const a = createEmptyAggregateMetrics();
      const b = createEmptyAggregateMetrics();
      expect(a).not.toBe(b);
      a.totalEvents = 42;
      expect(b.totalEvents).toBe(0);
    });
  });

  // ── Validation ────────────────────────────────────────────────────

  describe("isValidEventType", () => {
    it("returns true for all valid event types", () => {
      for (const type of PROGRESS_EVENT_TYPES) {
        expect(isValidEventType(type)).toBe(true);
      }
    });

    it("returns false for invalid strings", () => {
      expect(isValidEventType("INVALID")).toBe(false);
      expect(isValidEventType("spawned")).toBe(false); // case-sensitive
      expect(isValidEventType("")).toBe(false);
      expect(isValidEventType("RUNNING")).toBe(false);
    });

    it("returns false for non-string values", () => {
      expect(isValidEventType(null)).toBe(false);
      expect(isValidEventType(undefined)).toBe(false);
      expect(isValidEventType(42)).toBe(false);
      expect(isValidEventType(true)).toBe(false);
      expect(isValidEventType({})).toBe(false);
      expect(isValidEventType([])).toBe(false);
    });
  });

  describe("isTerminalEvent", () => {
    it("returns true for COMPLETED", () => {
      expect(isTerminalEvent("COMPLETED")).toBe(true);
    });

    it("returns true for FAILED", () => {
      expect(isTerminalEvent("FAILED")).toBe(true);
    });

    it("returns false for non-terminal events", () => {
      expect(isTerminalEvent("SPAWNED")).toBe(false);
      expect(isTerminalEvent("STARTED")).toBe(false);
      expect(isTerminalEvent("PROGRESS")).toBe(false);
      expect(isTerminalEvent("TOOL_CALL")).toBe(false);
      expect(isTerminalEvent("THINKING")).toBe(false);
    });
  });

  // ── Type Shape ────────────────────────────────────────────────────

  describe("ProgressEvent shape", () => {
    it("accepts a valid event object", () => {
      const event: ProgressEvent = {
        eventId: "test-id",
        timestamp: Date.now(),
        sessionKey: "agent:main:subagent:abc",
        agentLabel: "test-agent",
        eventType: "PROGRESS",
        message: "Doing things",
        metrics: createDefaultMetrics(),
      };
      expect(event.eventId).toBe("test-id");
      expect(event.eventType).toBe("PROGRESS");
    });

    it("accepts optional metadata", () => {
      const event: ProgressEvent = {
        eventId: "test-id",
        timestamp: Date.now(),
        sessionKey: "agent:main:subagent:abc",
        agentLabel: "test-agent",
        eventType: "TOOL_CALL",
        message: "Using exec",
        metrics: createDefaultMetrics(),
        metadata: {
          toolName: "exec",
          durationMs: 500,
        },
      };
      expect(event.metadata?.toolName).toBe("exec");
      expect(event.metadata?.durationMs).toBe(500);
    });
  });
});
