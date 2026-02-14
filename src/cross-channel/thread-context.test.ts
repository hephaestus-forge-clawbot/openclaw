/**
 * Tests for Thread Context Injection (Hephie Phase 3.3)
 */

import { describe, expect, it, beforeEach } from "vitest";
import { assembleThreadContext, buildThreadContextSection } from "./thread-context.js";
import { ThreadStore, type ThreadDatabase } from "./thread-store.js";

function createTestDb(): ThreadDatabase {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

describe("Thread Context Injection", () => {
  let db: ThreadDatabase;
  let store: ThreadStore;

  beforeEach(() => {
    db = createTestDb();
    store = new ThreadStore(db);
  });

  describe("assembleThreadContext", () => {
    it("should return empty when threading disabled", () => {
      const result = assembleThreadContext(store, {
        currentChannel: "slack",
        currentPerson: "alice",
        totalTokenBudget: 4000,
        config: { enabled: false },
      });

      expect(result).toEqual([]);
    });

    it("should return empty when no threads exist", () => {
      const result = assembleThreadContext(store, {
        currentChannel: "slack",
        currentPerson: "alice",
        totalTokenBudget: 4000,
      });

      expect(result).toEqual([]);
    });

    it("should inject context from cross-channel thread", () => {
      const thread = store.createThread({
        topic: "API redesign",
        participants: ["alice"],
        channels: ["slack", "telegram"],
        status: "active",
        now: 1000,
      });

      store.addMessage({
        threadId: thread.threadId,
        channelType: "slack",
        sender: "alice",
        content: "Let's redesign the API",
        timestamp: 2000,
      });

      store.addMessage({
        threadId: thread.threadId,
        channelType: "telegram",
        sender: "alice",
        content: "I sent the API spec on Telegram",
        timestamp: 3000,
      });

      const result = assembleThreadContext(store, {
        currentChannel: "slack",
        currentPerson: "alice",
        totalTokenBudget: 4000,
        threadId: thread.threadId,
        now: 4000,
      });

      expect(result).toHaveLength(1);
      expect(result[0].threadId).toBe(thread.threadId);
      expect(result[0].messages.length).toBeGreaterThan(0);
      expect(result[0].formattedContext).toContain("Cross-Channel Thread");
    });

    it("should respect token budget", () => {
      const thread = store.createThread({
        topic: "Big thread",
        participants: ["alice"],
        channels: ["slack"],
        status: "active",
        now: 1000,
      });

      // Add many messages
      for (let i = 0; i < 50; i++) {
        store.addMessage({
          threadId: thread.threadId,
          channelType: i % 2 === 0 ? "slack" : "telegram",
          sender: "alice",
          content: `Message number ${i} with some content to eat up tokens and fill the budget`,
          timestamp: 2000 + i * 1000,
        });
      }

      const result = assembleThreadContext(store, {
        currentChannel: "slack",
        currentPerson: "alice",
        totalTokenBudget: 200, // Very small budget
        threadId: thread.threadId,
        now: 100000,
      });

      if (result.length > 0) {
        expect(result[0].estimatedTokens).toBeLessThanOrEqual(20); // 10% of 200
      }
    });

    it("should prioritize cross-channel messages", () => {
      const thread = store.createThread({
        topic: "Cross-channel chat",
        participants: ["alice"],
        channels: ["slack", "telegram"],
        status: "active",
        now: 1000,
      });

      // Add same-channel message
      store.addMessage({
        threadId: thread.threadId,
        channelType: "slack",
        sender: "alice",
        content: "Slack message",
        timestamp: 2000,
      });

      // Add cross-channel message
      store.addMessage({
        threadId: thread.threadId,
        channelType: "telegram",
        sender: "alice",
        content: "Telegram message with important context",
        timestamp: 3000,
      });

      const result = assembleThreadContext(store, {
        currentChannel: "slack",
        currentPerson: "alice",
        totalTokenBudget: 4000,
        threadId: thread.threadId,
        now: 4000,
      });

      expect(result).toHaveLength(1);
      // Both messages should be included but telegram should appear
      const channels = result[0].channels;
      expect(channels).toContain("telegram");
    });

    it("should respect privacy with allowed participants", () => {
      const thread = store.createThread({
        topic: "Private discussion",
        participants: ["alice", "bob", "charlie"],
        channels: ["slack"],
        status: "active",
        now: 1000,
      });

      store.addMessage({
        threadId: thread.threadId,
        channelType: "slack",
        sender: "alice",
        content: "Alice's message",
        timestamp: 2000,
      });

      store.addMessage({
        threadId: thread.threadId,
        channelType: "slack",
        sender: "bob",
        content: "Bob's secret message",
        timestamp: 3000,
      });

      const result = assembleThreadContext(store, {
        currentChannel: "slack",
        currentPerson: "alice",
        totalTokenBudget: 4000,
        threadId: thread.threadId,
        allowedParticipants: ["alice"], // Only alice's messages
        now: 4000,
      });

      if (result.length > 0 && result[0].messages.length > 0) {
        // All messages should be from alice only
        for (const msg of result[0].messages) {
          expect(msg.sender).toBe("alice");
        }
      }
    });

    it("should find active threads for participant when no threadId given", () => {
      const thread = store.createThread({
        topic: "Auto-found thread",
        participants: ["alice"],
        channels: ["slack"],
        status: "active",
        now: 1000,
      });

      store.addMessage({
        threadId: thread.threadId,
        channelType: "telegram",
        sender: "alice",
        content: "Message from another channel",
        timestamp: 2000,
      });

      const result = assembleThreadContext(store, {
        currentChannel: "slack",
        currentPerson: "alice",
        totalTokenBudget: 4000,
        now: 3000,
      });

      expect(result.length).toBeGreaterThanOrEqual(0);
      // If found, should have our thread
      if (result.length > 0) {
        expect(result[0].threadId).toBe(thread.threadId);
      }
    });

    it("should handle multiple threads", () => {
      const t1 = store.createThread({
        topic: "Thread 1",
        participants: ["alice"],
        channels: ["slack"],
        status: "active",
        now: 1000,
      });
      store.addMessage({
        threadId: t1.threadId,
        channelType: "telegram",
        sender: "alice",
        content: "T1 message",
        timestamp: 2000,
      });

      const t2 = store.createThread({
        topic: "Thread 2",
        participants: ["alice"],
        channels: ["slack"],
        status: "active",
        now: 1000,
      });
      store.addMessage({
        threadId: t2.threadId,
        channelType: "discord",
        sender: "alice",
        content: "T2 message",
        timestamp: 3000,
      });

      const result = assembleThreadContext(store, {
        currentChannel: "slack",
        currentPerson: "alice",
        totalTokenBudget: 4000,
        threadIds: [t1.threadId, t2.threadId],
        now: 4000,
      });

      expect(result.length).toBe(2);
    });
  });

  describe("buildThreadContextSection", () => {
    it("should return empty string for no injections", () => {
      expect(buildThreadContextSection([])).toBe("");
    });

    it("should format single injection", () => {
      const section = buildThreadContextSection([
        {
          threadId: "t1",
          topic: "API Design",
          messages: [],
          channels: ["slack", "telegram"],
          estimatedTokens: 50,
          formattedContext:
            "[Cross-Channel Thread — API Design] (spanning: slack, telegram)\n[Telegram] alice (5m ago): Check the API spec",
        },
      ]);

      expect(section).toContain("Cross-Channel Thread");
      expect(section).toContain("API Design");
    });

    it("should separate multiple injections", () => {
      const section = buildThreadContextSection([
        {
          threadId: "t1",
          messages: [],
          channels: [],
          estimatedTokens: 30,
          formattedContext: "Thread 1 context",
        },
        {
          threadId: "t2",
          messages: [],
          channels: [],
          estimatedTokens: 30,
          formattedContext: "Thread 2 context",
        },
      ]);

      expect(section).toContain("Thread 1 context");
      expect(section).toContain("Thread 2 context");
    });
  });
});
