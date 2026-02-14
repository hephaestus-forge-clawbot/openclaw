/**
 * Tests for Channel History Tracker (Hephie Phase 3.1)
 */

import { describe, expect, it } from "vitest";
import { ChannelHistoryTracker, normalizeChannelType } from "./channel-history.js";

describe("ChannelHistoryTracker", () => {
  it("should start empty", () => {
    const tracker = new ChannelHistoryTracker();
    expect(tracker.getChannelCount()).toBe(0);
    expect(tracker.getAllChannels()).toEqual([]);
    expect(tracker.isMultiChannel()).toBe(false);
    expect(tracker.getTotalMessages()).toBe(0);
  });

  it("should record a message and create history entry", () => {
    const tracker = new ChannelHistoryTracker();
    const entry = tracker.recordMessage({
      channelType: "telegram",
      timestamp: 1000,
    });

    expect(entry.channelType).toBe("telegram");
    expect(entry.firstMessageAt).toBe(1000);
    expect(entry.lastMessageAt).toBe(1000);
    expect(entry.messageCount).toBe(1);
  });

  it("should update existing entry on subsequent messages", () => {
    const tracker = new ChannelHistoryTracker();
    tracker.recordMessage({ channelType: "telegram", timestamp: 1000 });
    const entry = tracker.recordMessage({ channelType: "telegram", timestamp: 2000 });

    expect(entry.firstMessageAt).toBe(1000);
    expect(entry.lastMessageAt).toBe(2000);
    expect(entry.messageCount).toBe(2);
  });

  it("should track multiple channels", () => {
    const tracker = new ChannelHistoryTracker();
    tracker.recordMessage({ channelType: "telegram", timestamp: 1000 });
    tracker.recordMessage({ channelType: "slack", timestamp: 2000 });

    expect(tracker.getChannelCount()).toBe(2);
    expect(tracker.isMultiChannel()).toBe(true);
    expect(tracker.getTotalMessages()).toBe(2);
  });

  it("should return channels ordered by most recent activity", () => {
    const tracker = new ChannelHistoryTracker();
    tracker.recordMessage({ channelType: "telegram", timestamp: 1000 });
    tracker.recordMessage({ channelType: "slack", timestamp: 3000 });
    tracker.recordMessage({ channelType: "discord", timestamp: 2000 });

    const channels = tracker.getAllChannels();
    expect(channels[0].channelType).toBe("slack");
    expect(channels[1].channelType).toBe("discord");
    expect(channels[2].channelType).toBe("telegram");
  });

  it("should get other channels excluding current", () => {
    const tracker = new ChannelHistoryTracker();
    tracker.recordMessage({ channelType: "telegram", timestamp: 1000 });
    tracker.recordMessage({ channelType: "slack", timestamp: 2000 });
    tracker.recordMessage({ channelType: "discord", timestamp: 3000 });

    const others = tracker.getOtherChannels("telegram");
    expect(others).toHaveLength(2);
    expect(others.map((e) => e.channelType)).toEqual(["discord", "slack"]);
  });

  it("should track topic and channel-specific IDs", () => {
    const tracker = new ChannelHistoryTracker();
    tracker.recordMessage({
      channelType: "telegram",
      timestamp: 1000,
      topic: "machine learning",
      channelUserId: "123456",
      channelChatId: "chat_789",
    });

    const entry = tracker.getChannel("telegram");
    expect(entry?.lastTopic).toBe("machine learning");
    expect(entry?.channelUserId).toBe("123456");
    expect(entry?.channelChatId).toBe("chat_789");
  });

  it("should update topic on new messages", () => {
    const tracker = new ChannelHistoryTracker();
    tracker.recordMessage({
      channelType: "telegram",
      timestamp: 1000,
      topic: "old topic",
    });
    tracker.recordMessage({
      channelType: "telegram",
      timestamp: 2000,
      topic: "new topic",
    });

    const entry = tracker.getChannel("telegram");
    expect(entry?.lastTopic).toBe("new topic");
  });

  it("should keep first message timestamp even with earlier subsequent messages", () => {
    const tracker = new ChannelHistoryTracker();
    tracker.recordMessage({ channelType: "telegram", timestamp: 2000 });
    tracker.recordMessage({ channelType: "telegram", timestamp: 1000 });

    const entry = tracker.getChannel("telegram");
    expect(entry?.firstMessageAt).toBe(1000);
    expect(entry?.lastMessageAt).toBe(2000);
  });

  it("should return undefined for unknown channel", () => {
    const tracker = new ChannelHistoryTracker();
    expect(tracker.getChannel("telegram")).toBeUndefined();
  });

  describe("serialization", () => {
    it("should round-trip through JSON", () => {
      const tracker = new ChannelHistoryTracker();
      tracker.recordMessage({ channelType: "telegram", timestamp: 1000, topic: "AI" });
      tracker.recordMessage({ channelType: "slack", timestamp: 2000 });

      const json = tracker.toJSON();
      const restored = ChannelHistoryTracker.fromJSON(json);

      expect(restored.getChannelCount()).toBe(2);
      expect(restored.getChannel("telegram")?.lastTopic).toBe("AI");
      expect(restored.getChannel("slack")?.messageCount).toBe(1);
    });

    it("should handle invalid JSON gracefully", () => {
      const tracker = ChannelHistoryTracker.fromJSON(null);
      expect(tracker.getChannelCount()).toBe(0);

      const tracker2 = ChannelHistoryTracker.fromJSON("not an array");
      expect(tracker2.getChannelCount()).toBe(0);

      const tracker3 = ChannelHistoryTracker.fromJSON([{ invalid: true }]);
      expect(tracker3.getChannelCount()).toBe(0);
    });

    it("should initialize from existing entries", () => {
      const tracker = new ChannelHistoryTracker([
        {
          channelType: "telegram",
          firstMessageAt: 1000,
          lastMessageAt: 2000,
          messageCount: 5,
        },
      ]);

      expect(tracker.getChannelCount()).toBe(1);
      expect(tracker.getChannel("telegram")?.messageCount).toBe(5);
    });
  });

  it("should return copies, not references", () => {
    const tracker = new ChannelHistoryTracker();
    tracker.recordMessage({ channelType: "telegram", timestamp: 1000 });

    const entry = tracker.getChannel("telegram");
    if (entry) {
      entry.messageCount = 999;
    }
    expect(tracker.getChannel("telegram")?.messageCount).toBe(1);
  });
});

describe("normalizeChannelType", () => {
  it("should normalize known aliases", () => {
    expect(normalizeChannelType("tg")).toBe("telegram");
    expect(normalizeChannelType("tele")).toBe("telegram");
    expect(normalizeChannelType("wa")).toBe("whatsapp");
    expect(normalizeChannelType("disc")).toBe("discord");
    expect(normalizeChannelType("web")).toBe("webchat");
    expect(normalizeChannelType("imsg")).toBe("imessage");
    expect(normalizeChannelType("imessages")).toBe("imessage");
  });

  it("should lowercase and trim", () => {
    expect(normalizeChannelType("  Telegram  ")).toBe("telegram");
    expect(normalizeChannelType("SLACK")).toBe("slack");
  });

  it("should pass through unknown types as lowercase", () => {
    expect(normalizeChannelType("matrix")).toBe("matrix");
    expect(normalizeChannelType("custom_channel")).toBe("custom_channel");
  });
});
