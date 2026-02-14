/**
 * Tests for Message Queue (Hephie Phase 3.2)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MessageQueue, calculateRetryDelay, DEFAULT_RETRY_POLICY } from "./message-queue.js";

describe("MessageQueue", () => {
  let tmpDir: string;
  let persistPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hephie-mq-test-"));
    persistPath = path.join(tmpDir, "queue.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should start empty", async () => {
    const queue = await MessageQueue.create({ persistPath });
    expect(queue.size).toBe(0);
    expect(queue.getStats()).toEqual({ pending: 0, dead: 0, total: 0 });
  });

  it("should enqueue a message", async () => {
    const queue = await MessageQueue.create({ persistPath });
    const msg = await queue.enqueue({
      channel: "telegram",
      to: "12345",
      message: "Hello!",
    });

    expect(msg.id).toBeTruthy();
    expect(msg.channel).toBe("telegram");
    expect(msg.to).toBe("12345");
    expect(msg.message).toBe("Hello!");
    expect(msg.attempts).toBe(0);
    expect(msg.dead).toBe(false);
    expect(queue.size).toBe(1);
  });

  it("should get next pending message", async () => {
    const queue = await MessageQueue.create({ persistPath });
    await queue.enqueue({ channel: "telegram", to: "1", message: "First" });
    await queue.enqueue({ channel: "slack", to: "2", message: "Second" });

    const next = queue.getNextPending();
    expect(next).toBeDefined();
    expect(next!.message).toBe("First"); // Oldest first
  });

  it("should get all pending messages", async () => {
    const queue = await MessageQueue.create({ persistPath });
    await queue.enqueue({ channel: "telegram", to: "1", message: "First" });
    await queue.enqueue({ channel: "slack", to: "2", message: "Second" });

    const pending = queue.getPendingMessages();
    expect(pending).toHaveLength(2);
    expect(pending[0].message).toBe("First");
    expect(pending[1].message).toBe("Second");
  });

  it("should mark message as delivered", async () => {
    const queue = await MessageQueue.create({ persistPath });
    const msg = await queue.enqueue({
      channel: "telegram",
      to: "12345",
      message: "Hello!",
    });

    const delivered = await queue.markDelivered(msg.id);
    expect(delivered).toBe(true);
    expect(queue.size).toBe(0);
  });

  it("should mark message as failed and schedule retry", async () => {
    const queue = await MessageQueue.create({
      persistPath,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000, backoffMultiplier: 2 },
    });
    const msg = await queue.enqueue({
      channel: "telegram",
      to: "12345",
      message: "Hello!",
    });

    const failed = await queue.markFailed(msg.id, "Connection refused");
    expect(failed).toBeDefined();
    expect(failed!.attempts).toBe(1);
    expect(failed!.lastError).toBe("Connection refused");
    expect(failed!.dead).toBe(false);
    expect(failed!.nextRetryAt).toBeDefined();
  });

  it("should move to dead letter queue after max attempts", async () => {
    const queue = await MessageQueue.create({
      persistPath,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 2 },
    });
    const msg = await queue.enqueue({
      channel: "telegram",
      to: "12345",
      message: "Hello!",
    });

    await queue.markFailed(msg.id, "Error 1");
    const dead = await queue.markFailed(msg.id, "Error 2");

    expect(dead!.dead).toBe(true);
    expect(dead!.attempts).toBe(2);
    expect(dead!.lastError).toBe("Error 2");
  });

  it("should not return pending messages before retry time", async () => {
    const queue = await MessageQueue.create({
      persistPath,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 60000, maxDelayMs: 120000, backoffMultiplier: 2 },
    });
    const msg = await queue.enqueue({
      channel: "telegram",
      to: "12345",
      message: "Hello!",
    });

    await queue.markFailed(msg.id, "Error");

    // The message should not be pending because nextRetryAt is in the future
    const pending = queue.getPendingMessages(Date.now());
    expect(pending).toHaveLength(0);

    // But should be pending if we check in the future
    const futurePending = queue.getPendingMessages(Date.now() + 120000);
    expect(futurePending).toHaveLength(1);
  });

  it("should get dead letters", async () => {
    const queue = await MessageQueue.create({
      persistPath,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 2 },
    });
    const msg = await queue.enqueue({
      channel: "telegram",
      to: "12345",
      message: "Hello!",
    });
    await queue.markFailed(msg.id, "Dead");

    const dead = queue.getDeadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0].message).toBe("Hello!");
    expect(dead[0].dead).toBe(true);
  });

  it("should retry dead letters", async () => {
    const queue = await MessageQueue.create({
      persistPath,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 2 },
    });
    const msg = await queue.enqueue({
      channel: "telegram",
      to: "12345",
      message: "Hello!",
    });
    await queue.markFailed(msg.id, "Dead");

    const retried = await queue.retryDeadLetter(msg.id);
    expect(retried!.dead).toBe(false);
    expect(retried!.attempts).toBe(0);
    expect(retried!.lastError).toBeUndefined();
  });

  it("should remove a message", async () => {
    const queue = await MessageQueue.create({ persistPath });
    const msg = await queue.enqueue({
      channel: "telegram",
      to: "12345",
      message: "Hello!",
    });

    expect(await queue.remove(msg.id)).toBe(true);
    expect(queue.size).toBe(0);
    expect(await queue.remove("nonexistent")).toBe(false);
  });

  it("should clear all messages", async () => {
    const queue = await MessageQueue.create({ persistPath });
    await queue.enqueue({ channel: "telegram", to: "1", message: "A" });
    await queue.enqueue({ channel: "slack", to: "2", message: "B" });

    await queue.clear();
    expect(queue.size).toBe(0);
  });

  it("should persist to disk and reload", async () => {
    // Create and populate queue
    const queue1 = await MessageQueue.create({ persistPath });
    await queue1.enqueue({ channel: "telegram", to: "12345", message: "Persisted!" });
    await queue1.enqueue({ channel: "slack", to: "C123", message: "Also persisted!" });

    // Create new queue from same path — should reload
    const queue2 = await MessageQueue.create({ persistPath });
    expect(queue2.size).toBe(2);
    const pending = queue2.getPendingMessages();
    expect(pending.some((m) => m.message === "Persisted!")).toBe(true);
    expect(pending.some((m) => m.message === "Also persisted!")).toBe(true);
  });

  it("should handle corrupt persistence file", async () => {
    fs.writeFileSync(persistPath, "not valid json", "utf-8");

    const queue = await MessageQueue.create({ persistPath });
    expect(queue.size).toBe(0); // Should start fresh
  });

  it("should get queue stats", async () => {
    const queue = await MessageQueue.create({
      persistPath,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 2 },
    });
    await queue.enqueue({ channel: "telegram", to: "1", message: "A" });
    const msg = await queue.enqueue({ channel: "slack", to: "2", message: "B" });
    await queue.markFailed(msg.id, "Dead");

    const stats = queue.getStats();
    expect(stats.pending).toBe(1);
    expect(stats.dead).toBe(1);
    expect(stats.total).toBe(2);
    expect(stats.oldestMessageAt).toBeDefined();
  });

  it("should store metadata on queued messages", async () => {
    const queue = await MessageQueue.create({ persistPath });
    const msg = await queue.enqueue({
      channel: "telegram",
      to: "12345",
      message: "Hello!",
      metadata: { source: "cron", priority: "high" },
    });

    expect(msg.metadata).toEqual({ source: "cron", priority: "high" });
  });

  it("should store account ID and thread ID", async () => {
    const queue = await MessageQueue.create({ persistPath });
    const msg = await queue.enqueue({
      channel: "telegram",
      to: "12345",
      message: "Hello!",
      accountId: "bot-1",
      threadId: "thread-99",
    });

    expect(msg.accountId).toBe("bot-1");
    expect(msg.threadId).toBe("thread-99");
  });
});

describe("calculateRetryDelay", () => {
  it("should return base delay for first attempt", () => {
    expect(calculateRetryDelay(1, DEFAULT_RETRY_POLICY)).toBe(1000);
  });

  it("should double for second attempt", () => {
    expect(calculateRetryDelay(2, DEFAULT_RETRY_POLICY)).toBe(2000);
  });

  it("should quadruple for third attempt", () => {
    expect(calculateRetryDelay(3, DEFAULT_RETRY_POLICY)).toBe(4000);
  });

  it("should cap at maxDelayMs", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 10000, maxDelayMs: 30000 };
    expect(calculateRetryDelay(5, policy)).toBe(30000);
  });

  it("should respect custom backoff multiplier", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, backoffMultiplier: 3 };
    expect(calculateRetryDelay(2, policy)).toBe(3000);
    expect(calculateRetryDelay(3, policy)).toBe(9000);
  });
});
