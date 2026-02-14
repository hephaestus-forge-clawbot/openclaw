/**
 * Tests for Send Command CLI (Hephie Phase 3.2)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { ChannelSendFn } from "./cross-channel-sender.js";
import type { ChannelType } from "./types.js";
import { CrossChannelSender } from "./cross-channel-sender.js";
import { MessageQueue } from "./message-queue.js";
import {
  parseSendArgs,
  validateSendArgs,
  executeSendCommand,
  SEND_COMMAND_HELP,
} from "./send-command.js";

describe("parseSendArgs", () => {
  it("should parse --channel, --to, --message", () => {
    const args = parseSendArgs(["--channel", "telegram", "--to", "12345", "--message", "Hello!"]);
    expect(args.channel).toBe("telegram");
    expect(args.to).toBe("12345");
    expect(args.message).toBe("Hello!");
  });

  it("should parse short flags", () => {
    const args = parseSendArgs(["-c", "slack", "-t", "#general", "-m", "Hi"]);
    expect(args.channel).toBe("slack");
    expect(args.to).toBe("#general");
    expect(args.message).toBe("Hi");
  });

  it("should parse --broadcast", () => {
    const args = parseSendArgs(["--broadcast", "--message", "Hello all!"]);
    expect(args.broadcast).toBe(true);
    expect(args.message).toBe("Hello all!");
  });

  it("should parse -b shorthand", () => {
    const args = parseSendArgs(["-b", "-m", "Hello all!"]);
    expect(args.broadcast).toBe(true);
  });

  it("should parse --queue flag", () => {
    const args = parseSendArgs(["-c", "telegram", "-t", "1", "-m", "Hi", "--queue"]);
    expect(args.queue).toBe(true);
  });

  it("should parse queue management flags", () => {
    expect(parseSendArgs(["--queue-status"]).queueStatus).toBe(true);
    expect(parseSendArgs(["--process-queue"]).processQueue).toBe(true);
    expect(parseSendArgs(["--retry-dead"]).retryDead).toBe(true);
    expect(parseSendArgs(["--show-dead"]).showDead).toBe(true);
    expect(parseSendArgs(["--clear-queue"]).clearQueue).toBe(true);
  });

  it("should parse --account-id and --thread-id", () => {
    const args = parseSendArgs([
      "-c",
      "telegram",
      "-t",
      "1",
      "-m",
      "Hi",
      "--account-id",
      "bot-1",
      "--thread-id",
      "thread-99",
    ]);
    expect(args.accountId).toBe("bot-1");
    expect(args.threadId).toBe("thread-99");
  });

  it("should treat non-flag argument as message", () => {
    const args = parseSendArgs(["-c", "telegram", "-t", "1", "Hello world"]);
    expect(args.message).toBe("Hello world");
  });
});

describe("validateSendArgs", () => {
  it("should pass for complete send args", () => {
    expect(validateSendArgs({ channel: "telegram", to: "12345", message: "Hello!" })).toBeNull();
  });

  it("should fail when message is missing", () => {
    expect(validateSendArgs({ channel: "telegram", to: "12345" })).toContain("--message");
  });

  it("should fail when channel is missing (non-broadcast)", () => {
    expect(validateSendArgs({ to: "12345", message: "Hello!" })).toContain("--channel");
  });

  it("should fail when to is missing (non-broadcast)", () => {
    expect(validateSendArgs({ channel: "telegram", message: "Hello!" })).toContain("--to");
  });

  it("should pass for broadcast without channel/to", () => {
    expect(validateSendArgs({ broadcast: true, message: "Hello!" })).toBeNull();
  });

  it("should pass for queue management commands", () => {
    expect(validateSendArgs({ queueStatus: true })).toBeNull();
    expect(validateSendArgs({ processQueue: true })).toBeNull();
    expect(validateSendArgs({ retryDead: true })).toBeNull();
    expect(validateSendArgs({ showDead: true })).toBeNull();
    expect(validateSendArgs({ clearQueue: true })).toBeNull();
  });
});

describe("executeSendCommand", () => {
  let sender: CrossChannelSender;
  let tmpDir: string;

  function createMockSendFn(channel: string): ChannelSendFn {
    return async (params) => ({
      success: true,
      messageId: `msg-${Date.now()}`,
      channel: channel as ChannelType,
      to: params.to,
    });
  }

  beforeEach(() => {
    sender = new CrossChannelSender();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hephie-cmd-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should send a message successfully", async () => {
    sender.registerChannel("telegram", createMockSendFn("telegram"));

    const result = await executeSendCommand(
      { channel: "telegram", to: "12345", message: "Hello!" },
      sender,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("✓");
    expect(result.output).toContain("telegram");
    expect(result.sendResult?.success).toBe(true);
  });

  it("should report send failure", async () => {
    sender.registerChannel("telegram", async () => {
      throw new Error("Connection refused");
    });

    const result = await executeSendCommand(
      { channel: "telegram", to: "12345", message: "Hello!" },
      sender,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("✗");
    expect(result.output).toContain("Connection refused");
  });

  it("should broadcast successfully", async () => {
    sender.registerChannel("telegram", createMockSendFn("telegram"));
    sender.registerChannel("slack", createMockSendFn("slack"));
    sender.registerBroadcastTarget({ channel: "telegram", defaultTo: "12345" });
    sender.registerBroadcastTarget({ channel: "slack", defaultTo: "C123" });

    const result = await executeSendCommand({ broadcast: true, message: "Hello all!" }, sender);

    expect(result.success).toBe(true);
    expect(result.output).toContain("2/2 succeeded");
    expect(result.broadcastResult?.successCount).toBe(2);
  });

  it("should show queue status", async () => {
    const queue = await MessageQueue.create({
      persistPath: path.join(tmpDir, "queue.json"),
    });
    await queue.enqueue({ channel: "telegram", to: "1", message: "A" });

    const result = await executeSendCommand({ queueStatus: true }, sender, queue);

    expect(result.success).toBe(true);
    expect(result.output).toContain("Pending: 1");
    expect(result.queueStats?.pending).toBe(1);
  });

  it("should show empty dead letter queue", async () => {
    const queue = await MessageQueue.create({
      persistPath: path.join(tmpDir, "queue.json"),
    });

    const result = await executeSendCommand({ showDead: true }, sender, queue);

    expect(result.success).toBe(true);
    expect(result.output).toContain("empty");
  });

  it("should process queue", async () => {
    const queue = await MessageQueue.create({
      persistPath: path.join(tmpDir, "queue.json"),
    });
    sender.setMessageQueue(queue);
    await queue.enqueue({ channel: "telegram", to: "12345", message: "Queued!" });
    sender.registerChannel("telegram", createMockSendFn("telegram"));

    const result = await executeSendCommand({ processQueue: true }, sender, queue);

    expect(result.success).toBe(true);
    expect(result.output).toContain("1 message(s) delivered");
  });

  it("should clear queue", async () => {
    const queue = await MessageQueue.create({
      persistPath: path.join(tmpDir, "queue.json"),
    });
    await queue.enqueue({ channel: "telegram", to: "1", message: "A" });

    const result = await executeSendCommand({ clearQueue: true }, sender, queue);

    expect(result.success).toBe(true);
    expect(result.output).toContain("cleared");
    expect(queue.size).toBe(0);
  });

  it("should return validation error for incomplete args", async () => {
    const result = await executeSendCommand({ channel: "telegram", to: "12345" }, sender);

    expect(result.success).toBe(false);
    expect(result.output).toContain("--message");
  });

  it("should queue on failure when requested", async () => {
    const queue = await MessageQueue.create({
      persistPath: path.join(tmpDir, "queue.json"),
    });
    sender.setMessageQueue(queue);

    // No channel registered → will fail and queue
    const result = await executeSendCommand(
      { channel: "telegram", to: "12345", message: "Hello!", queue: true },
      sender,
      queue,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("queued for retry");
  });

  it("should report when queue is not configured", async () => {
    const result = await executeSendCommand({ queueStatus: true }, sender);

    expect(result.success).toBe(false);
    expect(result.output).toContain("not configured");
  });
});

describe("SEND_COMMAND_HELP", () => {
  it("should contain usage examples", () => {
    expect(SEND_COMMAND_HELP).toContain("hephie send");
    expect(SEND_COMMAND_HELP).toContain("--channel");
    expect(SEND_COMMAND_HELP).toContain("--broadcast");
    expect(SEND_COMMAND_HELP).toContain("--queue-status");
  });
});
