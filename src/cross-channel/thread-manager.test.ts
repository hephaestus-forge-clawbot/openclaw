/**
 * Tests for Thread Manager (Hephie Phase 3.3)
 */

import { describe, expect, it, beforeEach } from "vitest";
import { ThreadManager, type SummaryGenerator } from "./thread-manager.js";
import { ThreadStore, type ThreadDatabase } from "./thread-store.js";

function createTestDb(): ThreadDatabase {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

describe("ThreadManager", () => {
  let db: ThreadDatabase;
  let store: ThreadStore;
  let manager: ThreadManager;

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  beforeEach(() => {
    db = createTestDb();
    store = new ThreadStore(db);
    manager = new ThreadManager(store, {
      staleAfterMs: 2 * HOUR,
      closeAfterMs: DAY,
      archiveAfterMs: 7 * DAY,
    });
  });

  // ── Lifecycle Transitions ──────────────────────────────────────────

  describe("Lifecycle Transitions", () => {
    it("should transition open threads to stale", async () => {
      store.createThread({ status: "open", now: 0 });
      store.createThread({ status: "open", now: 0 });
      store.createThread({ status: "open", now: 5 * HOUR }); // too recent

      const result = await manager.runMaintenance(3 * HOUR);
      expect(result.staled).toBe(2);
    });

    it("should transition active threads to stale", async () => {
      store.createThread({ status: "active", now: 0 });

      const result = await manager.runMaintenance(3 * HOUR);
      expect(result.staled).toBe(1);
    });

    it("should transition stale threads to closed", async () => {
      const t = store.createThread({ status: "stale", now: 0 });

      const result = await manager.runMaintenance(2 * DAY);
      expect(result.closed).toBe(1);

      const thread = store.getThread(t.threadId)!;
      expect(thread.status).toBe("closed");
      expect(thread.closedAt).toBeDefined();
    });

    it("should transition closed threads to archived", async () => {
      const t = store.createThread({ status: "closed", now: 0 });
      store.updateThread(t.threadId, { closedAt: 0 }, 0);

      const result = await manager.runMaintenance(10 * DAY);
      expect(result.archived).toBe(1);

      const thread = store.getThread(t.threadId)!;
      expect(thread.status).toBe("archived");
    });

    it("should handle full lifecycle in sequence", async () => {
      const t = store.createThread({
        status: "open",
        participants: ["alice"],
        channels: ["slack"],
        now: 0,
      });

      // Add a message
      store.addMessage({
        threadId: t.threadId,
        channelType: "slack",
        sender: "alice",
        content: "hello",
        timestamp: 100,
      });

      // After 3 hours: open → stale
      let result = await manager.runMaintenance(3 * HOUR);
      expect(result.staled).toBe(1);
      expect(store.getThread(t.threadId)!.status).toBe("stale");

      // After 2 days: stale → closed
      result = await manager.runMaintenance(2 * DAY);
      expect(result.closed).toBe(1);
      expect(store.getThread(t.threadId)!.status).toBe("closed");

      // After 10 days: closed → archived
      result = await manager.runMaintenance(10 * DAY);
      expect(result.archived).toBe(1);
      expect(store.getThread(t.threadId)!.status).toBe("archived");
    });

    it("should not transition threads that are too recent", async () => {
      store.createThread({ status: "open", now: 1000 });

      const result = await manager.runMaintenance(1500); // Only 500ms elapsed
      expect(result.staled).toBe(0);
      expect(result.closed).toBe(0);
      expect(result.archived).toBe(0);
    });
  });

  // ── Thread Closing ────────────────────────────────────────────────

  describe("Thread Closing", () => {
    it("should close a thread with simple summary", async () => {
      const thread = store.createThread({
        participants: ["alice", "bob"],
        channels: ["slack", "telegram"],
        now: 1000,
      });

      store.addMessage({
        threadId: thread.threadId,
        channelType: "slack",
        sender: "alice",
        content: "msg 1",
        timestamp: 2000,
      });
      store.addMessage({
        threadId: thread.threadId,
        channelType: "telegram",
        sender: "bob",
        content: "msg 2",
        timestamp: 3000,
      });

      const closed = await manager.closeThread(thread, 5000);
      expect(closed.status).toBe("closed");
      expect(closed.closedAt).toBe(5000);
      expect(closed.summary).toContain("2 participants");
      expect(closed.summary).toContain("2 channels");
      expect(closed.summary).toContain("2 messages");
    });

    it("should close with LLM summary when generator available", async () => {
      const mockGenerator: SummaryGenerator = async (params) => ({
        summary: `Discussion about ${params.topic ?? "various topics"}`,
        decisions: ["Use REST API"],
        actionItems: ["Write documentation"],
      });

      const managerWithSummary = new ThreadManager(store, { autoSummarize: true }, mockGenerator);

      const thread = store.createThread({
        topic: "API Design",
        participants: ["alice"],
        channels: ["slack"],
        now: 1000,
      });

      store.addMessage({
        threadId: thread.threadId,
        channelType: "slack",
        sender: "alice",
        content: "Let's use REST",
        timestamp: 2000,
      });

      const closed = await managerWithSummary.closeThread(thread, 5000);
      expect(closed.summary).toBe("Discussion about API Design");
      expect(closed.decisions).toContain("Use REST API");
      expect(closed.actionItems).toContain("Write documentation");
    });

    it("should fall back when summary generator fails", async () => {
      const failingGenerator: SummaryGenerator = async () => {
        throw new Error("LLM unavailable");
      };

      const managerWithFailing = new ThreadManager(
        store,
        { autoSummarize: true },
        failingGenerator,
      );

      const thread = store.createThread({
        participants: ["alice"],
        channels: ["slack"],
        now: 1000,
      });

      store.addMessage({
        threadId: thread.threadId,
        channelType: "slack",
        sender: "alice",
        content: "hello",
        timestamp: 2000,
      });

      const closed = await managerWithFailing.closeThread(thread, 5000);
      expect(closed.summary).toBeDefined();
      expect(closed.summary).toContain("participant");
    });
  });

  // ── Manual Transitions ────────────────────────────────────────────

  describe("Manual Transitions", () => {
    it("should allow valid transitions", () => {
      const t = store.createThread({ status: "open", now: 1000 });

      expect(manager.transitionThread(t.threadId, "active")).toBe(true);
      expect(store.getThread(t.threadId)!.status).toBe("active");

      expect(manager.transitionThread(t.threadId, "stale")).toBe(true);
      expect(store.getThread(t.threadId)!.status).toBe("stale");

      expect(manager.transitionThread(t.threadId, "closed")).toBe(true);
      expect(store.getThread(t.threadId)!.status).toBe("closed");
    });

    it("should reject invalid transitions", () => {
      const t = store.createThread({ status: "archived", now: 1000 });

      expect(manager.transitionThread(t.threadId, "open")).toBe(false);
      expect(store.getThread(t.threadId)!.status).toBe("archived");
    });

    it("should set closedAt when transitioning to closed", () => {
      const t = store.createThread({ status: "open", now: 1000 });

      manager.transitionThread(t.threadId, "closed", 5000);
      const thread = store.getThread(t.threadId)!;
      expect(thread.closedAt).toBe(5000);
    });

    it("should return false for non-existent thread", () => {
      expect(manager.transitionThread("nope", "active")).toBe(false);
    });
  });

  // ── Reopen ────────────────────────────────────────────────────────

  describe("Reopen", () => {
    it("should reopen a closed thread", () => {
      const t = store.createThread({ status: "closed", now: 1000 });
      store.updateThread(t.threadId, { closedAt: 2000 });

      expect(manager.reopenThread(t.threadId)).toBe(true);
      const thread = store.getThread(t.threadId)!;
      expect(thread.status).toBe("active");
    });

    it("should reopen a stale thread", () => {
      const t = store.createThread({ status: "stale", now: 1000 });

      expect(manager.reopenThread(t.threadId)).toBe(true);
      expect(store.getThread(t.threadId)!.status).toBe("active");
    });

    it("should not reopen an active thread", () => {
      const t = store.createThread({ status: "active", now: 1000 });
      expect(manager.reopenThread(t.threadId)).toBe(false);
    });

    it("should return false for non-existent thread", () => {
      expect(manager.reopenThread("nope")).toBe(false);
    });
  });

  // ── Config & Stats ────────────────────────────────────────────────

  describe("Config & Stats", () => {
    it("should return config", () => {
      const config = manager.getConfig();
      expect(config.staleAfterMs).toBe(2 * HOUR);
      expect(config.closeAfterMs).toBe(DAY);
    });

    it("should return stats", () => {
      store.createThread({ status: "open", now: 1000 });
      store.createThread({ status: "active", now: 2000 });

      const stats = manager.getStats();
      expect(stats.totalThreads).toBe(2);
      expect(stats.byStatus.open).toBe(1);
      expect(stats.byStatus.active).toBe(1);
    });
  });

  // ── Summary Generator ─────────────────────────────────────────────

  describe("Summary Generator", () => {
    it("should allow setting summary generator after construction", async () => {
      const thread = store.createThread({
        topic: "Test",
        participants: ["alice"],
        channels: ["slack"],
        now: 1000,
      });

      store.addMessage({
        threadId: thread.threadId,
        channelType: "slack",
        sender: "alice",
        content: "Important discussion",
        timestamp: 2000,
      });

      manager.setSummaryGenerator(async (params) => ({
        summary: `Summary: ${params.messages.length} messages`,
      }));

      // Need to create manager with autoSummarize enabled
      const mgr = new ThreadManager(store, { autoSummarize: true });
      mgr.setSummaryGenerator(async (params) => ({
        summary: `Summary: ${params.messages.length} messages`,
      }));

      const closed = await mgr.closeThread(thread, 5000);
      expect(closed.summary).toBe("Summary: 1 messages");
    });
  });
});
