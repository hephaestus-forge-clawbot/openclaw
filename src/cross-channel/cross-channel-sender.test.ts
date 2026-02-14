/**
 * Tests for Cross-Channel Sender (Hephie Phase 3.2)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { ChannelSendFn, SendResult } from "./cross-channel-sender.js";
import { CrossChannelSender } from "./cross-channel-sender.js";
import { MessageQueue } from "./message-queue.js";

describe("CrossChannelSender", () => {
  let sender: CrossChannelSender;

  beforeEach(() => {
    sender = new CrossChannelSender();
  });

  // Helper to create a mock send function
  function createMockSendFn(
    result: Partial<SendResult> = {},
  ): ChannelSendFn & { mock: { calls: Array<Parameters<ChannelSendFn>> } } {
    const calls: Array<Parameters<ChannelSendFn>> = [];
    const fn: ChannelSendFn & { mock: { calls: Array<Parameters<ChannelSendFn>> } } = Object.assign(
      async (params: Parameters<ChannelSendFn>[0]) => {
        calls.push([params]);
        return {
          success: true,
          channel: "telegram" as const,
          to: params.to,
          ...result,
        };
      },
      { mock: { calls } },
    );
    return fn;
  }

  it("should start with no registered channels", () => {
    expect(sender.getRegisteredChannels()).toHaveLength(0);
    expect(sender.hasChannel("telegram")).toBe(false);
  });

  it("should register a channel sender", () => {
    const sendFn = createMockSendFn();
    sender.registerChannel("telegram", sendFn);

    expect(sender.hasChannel("telegram")).toBe(true);
    expect(sender.getRegisteredChannels()).toContain("telegram");
  });

  it("should send a message through registered channel", async () => {
    const sendFn = createMockSendFn({ messageId: "msg-1" });
    sender.registerChannel("telegram", sendFn);

    const result = await sender.send({
      channel: "telegram",
      to: "12345",
      message: "Hello!",
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("msg-1");
    expect(sendFn.mock.calls).toHaveLength(1);
    expect(sendFn.mock.calls[0][0].to).toBe("12345");
    expect(sendFn.mock.calls[0][0].message).toBe("Hello!");
  });

  it("should fail for unregistered channel", async () => {
    const result = await sender.send({
      channel: "telegram",
      to: "12345",
      message: "Hello!",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No sender registered");
  });

  it("should handle send function throwing", async () => {
    sender.registerChannel("telegram", async () => {
      throw new Error("Connection refused");
    });

    const result = await sender.send({
      channel: "telegram",
      to: "12345",
      message: "Hello!",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Connection refused");
  });

  it("should pass account ID and thread ID to send function", async () => {
    const sendFn = createMockSendFn();
    sender.registerChannel("telegram", sendFn);

    await sender.send({
      channel: "telegram",
      to: "12345",
      message: "Hello!",
      accountId: "bot-1",
      threadId: "thread-99",
    });

    expect(sendFn.mock.calls[0][0].accountId).toBe("bot-1");
    expect(sendFn.mock.calls[0][0].threadId).toBe("thread-99");
  });

  describe("broadcast", () => {
    it("should broadcast to all targets", async () => {
      const telegramSend = createMockSendFn({ channel: "telegram" });
      const slackSend = createMockSendFn({ channel: "slack" });

      sender.registerChannel("telegram", telegramSend);
      sender.registerChannel("slack", slackSend);
      sender.registerBroadcastTarget({ channel: "telegram", defaultTo: "12345" });
      sender.registerBroadcastTarget({ channel: "slack", defaultTo: "C123" });

      const result = await sender.broadcast({ message: "Hello everyone!" });

      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(0);
      expect(result.results).toHaveLength(2);
    });

    it("should broadcast to specific channels only", async () => {
      const telegramSend = createMockSendFn({ channel: "telegram" });
      const slackSend = createMockSendFn({ channel: "slack" });

      sender.registerChannel("telegram", telegramSend);
      sender.registerChannel("slack", slackSend);
      sender.registerBroadcastTarget({ channel: "telegram", defaultTo: "12345" });
      sender.registerBroadcastTarget({ channel: "slack", defaultTo: "C123" });

      const result = await sender.broadcast({
        message: "Hello!",
        channels: ["telegram"],
      });

      expect(result.successCount).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].channel).toBe("telegram");
    });

    it("should handle partial broadcast failures", async () => {
      sender.registerChannel("telegram", createMockSendFn({ channel: "telegram" }));
      sender.registerChannel("slack", async () => {
        throw new Error("Slack down");
      });

      sender.registerBroadcastTarget({ channel: "telegram", defaultTo: "12345" });
      sender.registerBroadcastTarget({ channel: "slack", defaultTo: "C123" });

      const result = await sender.broadcast({ message: "Hello!" });

      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(1);
    });

    it("should return broadcast targets", () => {
      sender.registerBroadcastTarget({
        channel: "telegram",
        defaultTo: "12345",
        accountId: "bot-1",
      });

      const targets = sender.getBroadcastTargets();
      expect(targets).toHaveLength(1);
      expect(targets[0]).toEqual({
        channel: "telegram",
        defaultTo: "12345",
        accountId: "bot-1",
      });
    });
  });

  describe("queue integration", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hephie-sender-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should queue failed messages when queueOnFailure is true", async () => {
      const queue = await MessageQueue.create({
        persistPath: path.join(tmpDir, "queue.json"),
      });
      sender.setMessageQueue(queue);

      // No channel registered → will fail
      const result = await sender.send({
        channel: "telegram",
        to: "12345",
        message: "Hello!",
        queueOnFailure: true,
      });

      expect(result.success).toBe(false);
      expect(queue.size).toBe(1);
    });

    it("should not queue when queueOnFailure is false", async () => {
      const queue = await MessageQueue.create({
        persistPath: path.join(tmpDir, "queue.json"),
      });
      sender.setMessageQueue(queue);

      const result = await sender.send({
        channel: "telegram",
        to: "12345",
        message: "Hello!",
        queueOnFailure: false,
      });

      expect(result.success).toBe(false);
      expect(queue.size).toBe(0);
    });

    it("should process queued messages", async () => {
      const queue = await MessageQueue.create({
        persistPath: path.join(tmpDir, "queue.json"),
      });
      sender.setMessageQueue(queue);

      // Enqueue directly
      await queue.enqueue({ channel: "telegram", to: "12345", message: "Queued!" });

      // Now register the sender
      sender.registerChannel("telegram", createMockSendFn({ channel: "telegram" }));

      const delivered = await sender.processQueue();
      expect(delivered).toBe(1);
      expect(queue.size).toBe(0);
    });

    it("should handle queue processing when no queue is set", async () => {
      const delivered = await sender.processQueue();
      expect(delivered).toBe(0);
    });
  });

  it("should clear all registrations", () => {
    sender.registerChannel("telegram", createMockSendFn());
    sender.registerBroadcastTarget({ channel: "telegram", defaultTo: "12345" });

    sender.clear();
    expect(sender.hasChannel("telegram")).toBe(false);
    expect(sender.getBroadcastTargets()).toHaveLength(0);
  });
});
