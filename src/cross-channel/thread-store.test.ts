/**
 * Tests for Thread Store (Hephie Phase 3.3)
 */

import { describe, expect, it, beforeEach } from "vitest";
import { ThreadStore, type ThreadDatabase } from "./thread-store.js";

/**
 * In-memory SQLite database for testing.
 * Uses node:sqlite DatabaseSync.
 */
function createTestDb(): ThreadDatabase {
  // Use a minimal in-memory implementation for testing
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

describe("ThreadStore", () => {
  let db: ThreadDatabase;
  let store: ThreadStore;

  beforeEach(() => {
    db = createTestDb();
    store = new ThreadStore(db);
  });

  // ── Thread CRUD ─────────────────────────────────────────────────────

  describe("Thread CRUD", () => {
    it("should create a thread with defaults", () => {
      const thread = store.createThread({ now: 1000 });
      expect(thread.threadId).toBeDefined();
      expect(thread.status).toBe("open");
      expect(thread.participants).toEqual([]);
      expect(thread.channels).toEqual([]);
      expect(thread.createdAt).toBe(1000);
      expect(thread.updatedAt).toBe(1000);
    });

    it("should create a thread with full params", () => {
      const thread = store.createThread({
        topic: "Project discussion",
        participants: ["alice", "bob"],
        channels: ["slack", "telegram"],
        status: "active",
        metadata: { priority: "high" },
        now: 2000,
      });

      expect(thread.topic).toBe("Project discussion");
      expect(thread.participants).toEqual(["alice", "bob"]);
      expect(thread.channels).toEqual(["slack", "telegram"]);
      expect(thread.status).toBe("active");
      expect(thread.metadata).toEqual({ priority: "high" });
    });

    it("should get a thread by ID", () => {
      const created = store.createThread({ topic: "test", now: 1000 });
      const fetched = store.getThread(created.threadId);
      expect(fetched).toBeDefined();
      expect(fetched!.threadId).toBe(created.threadId);
      expect(fetched!.topic).toBe("test");
    });

    it("should return null for non-existent thread", () => {
      expect(store.getThread("non-existent")).toBeNull();
    });

    it("should update thread properties", () => {
      const thread = store.createThread({ topic: "old topic", now: 1000 });

      store.updateThread(
        thread.threadId,
        {
          topic: "new topic",
          status: "active",
          participants: ["alice"],
        },
        2000,
      );

      const updated = store.getThread(thread.threadId)!;
      expect(updated.topic).toBe("new topic");
      expect(updated.status).toBe("active");
      expect(updated.participants).toEqual(["alice"]);
      expect(updated.updatedAt).toBe(2000);
    });

    it("should update thread summary and decisions", () => {
      const thread = store.createThread({ now: 1000 });

      store.updateThread(thread.threadId, {
        summary: "We discussed the project plan",
        decisions: ["Use TypeScript", "Deploy on Monday"],
        actionItems: ["Write tests", "Update docs"],
        closedAt: 5000,
      });

      const updated = store.getThread(thread.threadId)!;
      expect(updated.summary).toBe("We discussed the project plan");
      expect(updated.decisions).toEqual(["Use TypeScript", "Deploy on Monday"]);
      expect(updated.actionItems).toEqual(["Write tests", "Update docs"]);
      expect(updated.closedAt).toBe(5000);
    });

    it("should delete a thread", () => {
      const thread = store.createThread({ now: 1000 });
      expect(store.deleteThread(thread.threadId)).toBe(true);
      expect(store.getThread(thread.threadId)).toBeNull();
    });

    it("should return false when deleting non-existent thread", () => {
      expect(store.deleteThread("nope")).toBe(false);
    });

    it("should cascade delete messages when deleting thread", () => {
      const thread = store.createThread({ now: 1000 });
      store.addMessage({
        threadId: thread.threadId,
        channelType: "slack",
        sender: "alice",
        content: "hello",
        timestamp: 2000,
      });

      expect(store.getMessageCount(thread.threadId)).toBe(1);
      store.deleteThread(thread.threadId);
      expect(store.getMessageCount(thread.threadId)).toBe(0);
    });
  });

  // ── Message CRUD ────────────────────────────────────────────────────

  describe("Message CRUD", () => {
    it("should add a message to a thread", () => {
      const thread = store.createThread({ now: 1000 });
      const msg = store.addMessage({
        threadId: thread.threadId,
        channelType: "telegram",
        sender: "alice",
        content: "Hello from Telegram!",
        platformMessageId: "tg-123",
        channelChatId: "chat-456",
        timestamp: 2000,
      });

      expect(msg.messageId).toBeDefined();
      expect(msg.threadId).toBe(thread.threadId);
      expect(msg.channelType).toBe("telegram");
      expect(msg.sender).toBe("alice");
      expect(msg.content).toBe("Hello from Telegram!");
      expect(msg.platformMessageId).toBe("tg-123");
      expect(msg.timestamp).toBe(2000);
    });

    it("should update thread participants and channels on message add", () => {
      const thread = store.createThread({ now: 1000 });

      store.addMessage({
        threadId: thread.threadId,
        channelType: "slack",
        sender: "bob",
        content: "hey",
        timestamp: 2000,
      });

      const updated = store.getThread(thread.threadId)!;
      expect(updated.participants).toContain("bob");
      expect(updated.channels).toContain("slack");
    });

    it("should get messages in chronological order", () => {
      const thread = store.createThread({ now: 1000 });

      store.addMessage({
        threadId: thread.threadId,
        channelType: "slack",
        sender: "alice",
        content: "first",
        timestamp: 2000,
      });
      store.addMessage({
        threadId: thread.threadId,
        channelType: "telegram",
        sender: "bob",
        content: "second",
        timestamp: 3000,
      });
      store.addMessage({
        threadId: thread.threadId,
        channelType: "discord",
        sender: "alice",
        content: "third",
        timestamp: 4000,
      });

      const messages = store.getMessages(thread.threadId);
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe("first");
      expect(messages[1].content).toBe("second");
      expect(messages[2].content).toBe("third");
    });

    it("should limit messages when requested", () => {
      const thread = store.createThread({ now: 1000 });
      for (let i = 0; i < 5; i++) {
        store.addMessage({
          threadId: thread.threadId,
          channelType: "slack",
          sender: "alice",
          content: `msg ${i}`,
          timestamp: 2000 + i * 1000,
        });
      }

      const messages = store.getMessages(thread.threadId, 2);
      expect(messages).toHaveLength(2);
    });

    it("should get recent messages by sender", () => {
      const t1 = store.createThread({ now: 1000 });
      const t2 = store.createThread({ now: 1000 });

      store.addMessage({
        threadId: t1.threadId,
        channelType: "slack",
        sender: "alice",
        content: "thread 1 msg",
        timestamp: 2000,
      });
      store.addMessage({
        threadId: t2.threadId,
        channelType: "telegram",
        sender: "alice",
        content: "thread 2 msg",
        timestamp: 3000,
      });
      store.addMessage({
        threadId: t1.threadId,
        channelType: "slack",
        sender: "bob",
        content: "bob's msg",
        timestamp: 4000,
      });

      const aliceMsgs = store.getRecentMessagesBySender("alice");
      expect(aliceMsgs).toHaveLength(2);
    });

    it("should get recent messages by channel", () => {
      const thread = store.createThread({ now: 1000 });

      store.addMessage({
        threadId: thread.threadId,
        channelType: "slack",
        sender: "alice",
        content: "slack msg",
        timestamp: 2000,
      });
      store.addMessage({
        threadId: thread.threadId,
        channelType: "telegram",
        sender: "bob",
        content: "telegram msg",
        timestamp: 3000,
      });

      const slackMsgs = store.getRecentMessagesByChannel("slack");
      expect(slackMsgs).toHaveLength(1);
      expect(slackMsgs[0].channelType).toBe("slack");
    });

    it("should get thread with messages", () => {
      const thread = store.createThread({ topic: "test", now: 1000 });
      store.addMessage({
        threadId: thread.threadId,
        channelType: "slack",
        sender: "alice",
        content: "hello",
        timestamp: 2000,
      });

      const full = store.getThreadWithMessages(thread.threadId);
      expect(full).toBeDefined();
      expect(full!.messages).toHaveLength(1);
      expect(full!.messages![0].content).toBe("hello");
    });

    it("should count messages", () => {
      const thread = store.createThread({ now: 1000 });
      expect(store.getMessageCount(thread.threadId)).toBe(0);

      store.addMessage({
        threadId: thread.threadId,
        channelType: "slack",
        sender: "alice",
        content: "one",
        timestamp: 2000,
      });
      store.addMessage({
        threadId: thread.threadId,
        channelType: "telegram",
        sender: "bob",
        content: "two",
        timestamp: 3000,
      });

      expect(store.getMessageCount(thread.threadId)).toBe(2);
    });
  });

  // ── Platform Mappings ───────────────────────────────────────────────

  describe("Platform Mappings", () => {
    it("should create and retrieve platform mapping", () => {
      const thread = store.createThread({ now: 1000 });

      store.addPlatformMapping({
        threadId: thread.threadId,
        channelType: "slack",
        platformThreadId: "1234567890.123456",
        platformChatId: "C12345",
        now: 2000,
      });

      const found = store.getThreadByPlatformId("slack", "1234567890.123456", "C12345");
      expect(found).toBeDefined();
      expect(found!.threadId).toBe(thread.threadId);
    });

    it("should return null for unknown platform mapping", () => {
      const found = store.getThreadByPlatformId("slack", "unknown", "unknown");
      expect(found).toBeNull();
    });

    it("should get all mappings for a thread", () => {
      const thread = store.createThread({ now: 1000 });

      store.addPlatformMapping({
        threadId: thread.threadId,
        channelType: "slack",
        platformThreadId: "slack-thread-1",
        platformChatId: "C12345",
      });
      store.addPlatformMapping({
        threadId: thread.threadId,
        channelType: "telegram",
        platformThreadId: "42",
        platformChatId: "-100123",
      });

      const mappings = store.getPlatformMappings(thread.threadId);
      expect(mappings).toHaveLength(2);
    });

    it("should remove platform mapping", () => {
      const thread = store.createThread({ now: 1000 });

      store.addPlatformMapping({
        threadId: thread.threadId,
        channelType: "slack",
        platformThreadId: "slack-thread",
        platformChatId: "C123",
      });

      expect(store.removePlatformMapping("slack", "slack-thread", "C123")).toBe(true);
      expect(store.getThreadByPlatformId("slack", "slack-thread", "C123")).toBeNull();
    });
  });

  // ── Search ────────────────────────────────────────────────────────

  describe("Search", () => {
    it("should search by participant", () => {
      store.createThread({
        participants: ["alice", "bob"],
        now: 1000,
      });
      store.createThread({
        participants: ["charlie"],
        now: 2000,
      });

      const results = store.searchThreads({ participant: "alice" });
      expect(results).toHaveLength(1);
      expect(results[0].participants).toContain("alice");
    });

    it("should search by topic", () => {
      store.createThread({ topic: "Machine learning project", now: 1000 });
      store.createThread({ topic: "Vacation planning", now: 2000 });

      const results = store.searchThreads({ topic: "learning" });
      expect(results).toHaveLength(1);
      expect(results[0].topic).toContain("learning");
    });

    it("should search by channel type", () => {
      store.createThread({ channels: ["slack", "telegram"], now: 1000 });
      store.createThread({ channels: ["discord"], now: 2000 });

      const results = store.searchThreads({ channelType: "slack" });
      expect(results).toHaveLength(1);
    });

    it("should search by status", () => {
      store.createThread({ status: "active", now: 1000 });
      store.createThread({ status: "closed", now: 2000 });
      store.createThread({ status: "active", now: 3000 });

      const results = store.searchThreads({ status: "active" });
      expect(results).toHaveLength(2);
    });

    it("should search by multiple statuses", () => {
      store.createThread({ status: "open", now: 1000 });
      store.createThread({ status: "active", now: 2000 });
      store.createThread({ status: "closed", now: 3000 });

      const results = store.searchThreads({ status: ["open", "active"] });
      expect(results).toHaveLength(2);
    });

    it("should search by date range", () => {
      store.createThread({ now: 1000 });
      store.createThread({ now: 5000 });
      store.createThread({ now: 10000 });

      const results = store.searchThreads({
        updatedAfter: 3000,
        updatedBefore: 8000,
      });
      expect(results).toHaveLength(1);
    });

    it("should respect limit and offset", () => {
      for (let i = 0; i < 10; i++) {
        store.createThread({ now: i * 1000 });
      }

      const page1 = store.searchThreads({ limit: 3, offset: 0 });
      const page2 = store.searchThreads({ limit: 3, offset: 3 });
      expect(page1).toHaveLength(3);
      expect(page2).toHaveLength(3);
      expect(page1[0].threadId).not.toBe(page2[0].threadId);
    });

    it("should get active threads for participant", () => {
      store.createThread({
        participants: ["alice"],
        status: "active",
        now: 1000,
      });
      store.createThread({
        participants: ["alice"],
        status: "closed",
        now: 2000,
      });
      store.createThread({
        participants: ["bob"],
        status: "active",
        now: 3000,
      });

      const results = store.getActiveThreadsForParticipant("alice");
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("active");
    });

    it("should get threads by status older than cutoff", () => {
      store.createThread({ status: "active", now: 1000 });
      store.createThread({ status: "active", now: 5000 });
      store.createThread({ status: "active", now: 10000 });

      const results = store.getThreadsByStatusOlderThan("active", 6000);
      expect(results).toHaveLength(2);
    });
  });

  // ── Stats ─────────────────────────────────────────────────────────

  describe("Stats", () => {
    it("should return accurate stats", () => {
      const t1 = store.createThread({ status: "open", now: 1000 });
      store.createThread({ status: "active", now: 2000 });
      store.createThread({ status: "closed", now: 3000 });

      store.addMessage({
        threadId: t1.threadId,
        channelType: "slack",
        sender: "alice",
        content: "hi",
        timestamp: 4000,
      });

      store.addPlatformMapping({
        threadId: t1.threadId,
        channelType: "slack",
        platformThreadId: "st-1",
        platformChatId: "C1",
      });

      const stats = store.getStats();
      expect(stats.totalThreads).toBe(3);
      expect(stats.byStatus.open).toBe(1);
      expect(stats.byStatus.active).toBe(1);
      expect(stats.byStatus.closed).toBe(1);
      expect(stats.totalMessages).toBe(1);
      expect(stats.totalMappings).toBe(1);
    });
  });
});
