/**
 * Tests for Thread Linker (Hephie Phase 3.3)
 */

import { describe, expect, it, beforeEach } from "vitest";
import { ThreadLinker } from "./thread-linker.js";
import { ThreadStore, type ThreadDatabase } from "./thread-store.js";

function createTestDb(): ThreadDatabase {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

describe("ThreadLinker", () => {
  let db: ThreadDatabase;
  let store: ThreadStore;
  let linker: ThreadLinker;

  beforeEach(() => {
    db = createTestDb();
    store = new ThreadStore(db);
    linker = new ThreadLinker(store, {
      implicitLinkWindowMs: 30 * 60 * 1000, // 30 min
      minTopicSimilarity: 0.2,
    });
  });

  // ── Explicit Linking ────────────────────────────────────────────────

  describe("Explicit Linking", () => {
    it("should link a message to an existing thread", () => {
      const thread = store.createThread({
        topic: "API redesign",
        participants: ["alice"],
        channels: ["slack"],
        now: 1000,
      });

      const result = linker.linkToThread({
        threadId: thread.threadId,
        channelType: "telegram",
        sender: "alice",
        content: "Sent the API spec doc here",
        timestamp: 2000,
      });

      expect(result.linked).toBe(true);
      expect(result.thread!.threadId).toBe(thread.threadId);
      expect(result.message!.channelType).toBe("telegram");
      expect(result.linkType).toBe("explicit");
    });

    it("should fail to link to non-existent thread", () => {
      const result = linker.linkToThread({
        threadId: "non-existent",
        channelType: "slack",
        sender: "alice",
        content: "hello",
      });

      expect(result.linked).toBe(false);
    });

    it("should update thread participants on explicit link", () => {
      const thread = store.createThread({
        participants: ["alice"],
        channels: ["slack"],
        now: 1000,
      });

      linker.linkToThread({
        threadId: thread.threadId,
        channelType: "telegram",
        sender: "bob",
        content: "Joining the discussion",
        timestamp: 2000,
      });

      const updated = store.getThread(thread.threadId)!;
      expect(updated.participants).toContain("bob");
      expect(updated.channels).toContain("telegram");
    });
  });

  // ── Auto Linking ──────────────────────────────────────────────────

  describe("Auto Linking", () => {
    it("should auto-link to thread with matching topic", () => {
      const thread = store.createThread({
        topic: "API redesign project",
        participants: ["alice"],
        channels: ["slack"],
        now: 1000,
      });

      // Add some messages to give the thread content
      store.addMessage({
        threadId: thread.threadId,
        channelType: "slack",
        sender: "alice",
        content: "We need to redesign the REST API endpoints",
        timestamp: 2000,
      });
      store.addMessage({
        threadId: thread.threadId,
        channelType: "slack",
        sender: "alice",
        content: "The API authentication needs updating too",
        timestamp: 3000,
      });

      const result = linker.autoLink({
        channelType: "telegram",
        sender: "alice",
        content: "I've started working on the API redesign endpoints",
        timestamp: 4000,
      });

      expect(result.linked).toBe(true);
      expect(result.linkType).toBe("implicit");
      expect(result.similarity).toBeGreaterThan(0);
    });

    it("should create new thread when createIfMissing is true", () => {
      const result = linker.autoLink({
        channelType: "slack",
        sender: "alice",
        content: "Starting a completely new topic about quantum physics",
        createIfMissing: true,
        topic: "Quantum Physics",
        timestamp: 1000,
      });

      expect(result.linked).toBe(true);
      expect(result.linkType).toBe("new");
      expect(result.thread!.topic).toBe("Quantum Physics");
    });

    it("should not create thread when createIfMissing is false", () => {
      const result = linker.autoLink({
        channelType: "slack",
        sender: "alice",
        content: "Random unrelated message",
        createIfMissing: false,
        timestamp: 1000,
      });

      expect(result.linked).toBe(false);
    });

    it("should prefer threads with matching participants", () => {
      // Thread 1: alice's thread about deployment
      const t1 = store.createThread({
        topic: "Deployment pipeline",
        participants: ["alice"],
        channels: ["slack"],
        now: 1000,
      });
      store.addMessage({
        threadId: t1.threadId,
        channelType: "slack",
        sender: "alice",
        content: "Working on deployment pipeline updates",
        timestamp: 2000,
      });

      // Thread 2: bob's thread about deployment
      const t2 = store.createThread({
        topic: "Deployment review",
        participants: ["bob"],
        channels: ["slack"],
        now: 1000,
      });
      store.addMessage({
        threadId: t2.threadId,
        channelType: "slack",
        sender: "bob",
        content: "Reviewing deployment changes",
        timestamp: 2000,
      });

      // Alice's new message about deployment
      const result = linker.autoLink({
        channelType: "telegram",
        sender: "alice",
        content: "Deployment pipeline is ready for testing",
        timestamp: 3000,
      });

      if (result.linked) {
        // Should prefer alice's thread
        expect(result.thread!.participants).toContain("alice");
      }
    });

    it("should not link to stale threads outside time window", () => {
      const thread = store.createThread({
        topic: "Old discussion",
        participants: ["alice"],
        channels: ["slack"],
        status: "active",
        now: 1000,
      });
      store.addMessage({
        threadId: thread.threadId,
        channelType: "slack",
        sender: "alice",
        content: "Old discussion about APIs",
        timestamp: 1000,
      });

      // Update thread timestamp to be old (simulate staleness)
      store.updateThread(thread.threadId, {}, 1000);

      // New message way outside the window
      const result = linker.autoLink({
        channelType: "telegram",
        sender: "alice",
        content: "New discussion about APIs",
        timestamp: 1000 + 60 * 60 * 1000, // 1 hour later, outside 30 min window
      });

      // Should not link to the old thread
      expect(result.linked).toBe(false);
    });
  });

  // ── Platform Linking ──────────────────────────────────────────────

  describe("Platform Linking", () => {
    it("should link via existing platform mapping", () => {
      const thread = store.createThread({
        topic: "Slack thread",
        channels: ["slack"],
        now: 1000,
      });

      store.addPlatformMapping({
        threadId: thread.threadId,
        channelType: "slack",
        platformThreadId: "1234567890.123456",
        platformChatId: "C12345",
      });

      const result = linker.linkViaPlatform({
        channelType: "slack",
        platformThreadId: "1234567890.123456",
        platformChatId: "C12345",
        sender: "bob",
        content: "Replying in thread",
        timestamp: 2000,
      });

      expect(result.linked).toBe(true);
      expect(result.linkType).toBe("platform");
      expect(result.thread!.threadId).toBe(thread.threadId);
    });

    it("should create thread and mapping when createIfMissing", () => {
      const result = linker.linkViaPlatform({
        channelType: "telegram",
        platformThreadId: "42",
        platformChatId: "-100123",
        sender: "alice",
        content: "Starting a topic",
        createIfMissing: true,
        topic: "Telegram Topic",
        timestamp: 1000,
      });

      expect(result.linked).toBe(true);
      expect(result.linkType).toBe("platform");
      expect(result.thread!.topic).toBe("Telegram Topic");

      // Verify mapping was created
      const found = store.getThreadByPlatformId("telegram", "42", "-100123");
      expect(found).toBeDefined();
      expect(found!.threadId).toBe(result.thread!.threadId);
    });

    it("should not create when createIfMissing is false", () => {
      const result = linker.linkViaPlatform({
        channelType: "slack",
        platformThreadId: "unknown",
        platformChatId: "unknown",
        sender: "alice",
        content: "hello",
        createIfMissing: false,
      });

      expect(result.linked).toBe(false);
    });
  });

  // ── Reply Linking ─────────────────────────────────────────────────

  describe("Reply Linking", () => {
    it("should link reply to same thread as original message", () => {
      const thread = store.createThread({
        topic: "Discussion",
        channels: ["slack"],
        now: 1000,
      });

      store.addMessage({
        threadId: thread.threadId,
        channelType: "slack",
        sender: "alice",
        content: "Check this out",
        platformMessageId: "msg-123",
        timestamp: 2000,
      });

      const result = linker.linkReply({
        replyToMessageId: "msg-123",
        channelType: "telegram",
        sender: "bob",
        content: "Looks good!",
        timestamp: 3000,
      });

      expect(result.linked).toBe(true);
      expect(result.linkType).toBe("reply");
      expect(result.thread!.threadId).toBe(thread.threadId);
    });

    it("should fail to link reply when original not found", () => {
      const result = linker.linkReply({
        replyToMessageId: "non-existent",
        channelType: "slack",
        sender: "alice",
        content: "reply",
      });

      expect(result.linked).toBe(false);
    });
  });

  // ── Platform Thread Mapping ───────────────────────────────────────

  describe("Platform Thread Mapping", () => {
    it("should map platform thread to unified thread", () => {
      const thread = store.createThread({ now: 1000 });

      const mapping = linker.mapPlatformThread({
        threadId: thread.threadId,
        channelType: "discord",
        platformThreadId: "discord-thread-123",
        platformChatId: "guild-456",
      });

      expect(mapping).toBeDefined();
      expect(mapping!.channelType).toBe("discord");

      // Verify lookup works
      const found = store.getThreadByPlatformId("discord", "discord-thread-123", "guild-456");
      expect(found!.threadId).toBe(thread.threadId);
    });

    it("should return null for non-existent thread", () => {
      const mapping = linker.mapPlatformThread({
        threadId: "nope",
        channelType: "slack",
        platformThreadId: "st",
        platformChatId: "sc",
      });
      expect(mapping).toBeNull();
    });
  });
});
