/**
 * Tests for Session Model Enhancer (Hephie Phase 3.1)
 */

import { describe, expect, it } from "vitest";
import {
  updateChannelHistory,
  extractChannelType,
  extractSenderIdentity,
  sessionsMatchPerson,
} from "./session-enhancer.js";

describe("updateChannelHistory", () => {
  it("should create new history from undefined", () => {
    const result = updateChannelHistory(undefined, {
      channelType: "telegram",
      timestamp: 1000,
    });

    expect(result).toHaveLength(1);
    expect(result[0].channelType).toBe("telegram");
    expect(result[0].firstMessageAt).toBe(1000);
    expect(result[0].lastMessageAt).toBe(1000);
    expect(result[0].messageCount).toBe(1);
  });

  it("should update existing history", () => {
    const existing = [
      {
        channelType: "telegram" as const,
        firstMessageAt: 1000,
        lastMessageAt: 1000,
        messageCount: 1,
      },
    ];

    const result = updateChannelHistory(existing, {
      channelType: "telegram",
      timestamp: 2000,
    });

    expect(result).toHaveLength(1);
    expect(result[0].messageCount).toBe(2);
    expect(result[0].lastMessageAt).toBe(2000);
  });

  it("should add new channel to existing history", () => {
    const existing = [
      {
        channelType: "telegram" as const,
        firstMessageAt: 1000,
        lastMessageAt: 1000,
        messageCount: 1,
      },
    ];

    const result = updateChannelHistory(existing, {
      channelType: "slack",
      timestamp: 2000,
    });

    expect(result).toHaveLength(2);
  });

  it("should normalize channel types", () => {
    const result = updateChannelHistory(undefined, {
      channelType: "tg",
      timestamp: 1000,
    });

    expect(result[0].channelType).toBe("telegram");
  });

  it("should include topic and IDs", () => {
    const result = updateChannelHistory(undefined, {
      channelType: "telegram",
      timestamp: 1000,
      topic: "ML research",
      channelUserId: "123",
      channelChatId: "chat_456",
    });

    expect(result[0].lastTopic).toBe("ML research");
    expect(result[0].channelUserId).toBe("123");
    expect(result[0].channelChatId).toBe("chat_456");
  });
});

describe("extractChannelType", () => {
  it("should extract from channel field", () => {
    expect(extractChannelType({ channel: "telegram" })).toBe("telegram");
  });

  it("should extract from lastChannel field", () => {
    expect(extractChannelType({ lastChannel: "slack" })).toBe("slack");
  });

  it("should extract from origin.provider", () => {
    expect(extractChannelType({ origin: { provider: "discord" } })).toBe("discord");
  });

  it("should extract from origin.surface", () => {
    expect(extractChannelType({ origin: { surface: "whatsapp" } })).toBe("whatsapp");
  });

  it("should prioritize channel over lastChannel", () => {
    expect(extractChannelType({ channel: "telegram", lastChannel: "slack" })).toBe("telegram");
  });

  it("should return undefined when no channel info", () => {
    expect(extractChannelType({})).toBeUndefined();
  });

  it("should normalize channel type", () => {
    expect(extractChannelType({ channel: "TG" })).toBe("telegram");
  });
});

describe("extractSenderIdentity", () => {
  it("should extract from Surface + SenderId", () => {
    const result = extractSenderIdentity({
      Surface: "telegram",
      SenderId: "123456",
    });

    expect(result?.channelType).toBe("telegram");
    expect(result?.userId).toBe("123456");
  });

  it("should use OriginatingChannel over Surface", () => {
    const result = extractSenderIdentity({
      OriginatingChannel: "slack",
      Surface: "webchat",
      SenderId: "U123",
    });

    expect(result?.channelType).toBe("slack");
  });

  it("should use E164 for WhatsApp", () => {
    const result = extractSenderIdentity({
      Surface: "whatsapp",
      SenderE164: "+44123456789",
    });

    expect(result?.channelType).toBe("whatsapp");
    expect(result?.userId).toBe("+44123456789");
  });

  it("should use From as fallback", () => {
    const result = extractSenderIdentity({
      Surface: "telegram",
      From: "alice",
    });

    expect(result?.channelType).toBe("telegram");
    expect(result?.userId).toBe("alice");
  });

  it("should return undefined without channel info", () => {
    expect(extractSenderIdentity({ SenderId: "123" })).toBeUndefined();
  });

  it("should return undefined without any sender info", () => {
    expect(extractSenderIdentity({ Surface: "telegram" })).toBeUndefined();
  });
});

describe("sessionsMatchPerson", () => {
  it("should match on crossChannelPerson", () => {
    expect(
      sessionsMatchPerson({ crossChannelPerson: "alice" }, { crossChannelPerson: "alice" }),
    ).toBe(true);
  });

  it("should match case-insensitively", () => {
    expect(
      sessionsMatchPerson({ crossChannelPerson: "Alice" }, { crossChannelPerson: "alice" }),
    ).toBe(true);
  });

  it("should not match different people", () => {
    expect(
      sessionsMatchPerson({ crossChannelPerson: "alice" }, { crossChannelPerson: "bob" }),
    ).toBe(false);
  });

  it("should match on shared channel user IDs", () => {
    expect(
      sessionsMatchPerson(
        {
          channelHistory: [
            {
              channelType: "telegram",
              firstMessageAt: 0,
              lastMessageAt: 0,
              messageCount: 1,
              channelUserId: "123",
            },
          ],
        },
        {
          channelHistory: [
            {
              channelType: "telegram",
              firstMessageAt: 0,
              lastMessageAt: 0,
              messageCount: 1,
              channelUserId: "123",
            },
          ],
        },
      ),
    ).toBe(true);
  });

  it("should not match on different channel user IDs", () => {
    expect(
      sessionsMatchPerson(
        {
          channelHistory: [
            {
              channelType: "telegram",
              firstMessageAt: 0,
              lastMessageAt: 0,
              messageCount: 1,
              channelUserId: "123",
            },
          ],
        },
        {
          channelHistory: [
            {
              channelType: "telegram",
              firstMessageAt: 0,
              lastMessageAt: 0,
              messageCount: 1,
              channelUserId: "456",
            },
          ],
        },
      ),
    ).toBe(false);
  });

  it("should not match when channelUserId is missing", () => {
    expect(
      sessionsMatchPerson(
        {
          channelHistory: [
            { channelType: "telegram", firstMessageAt: 0, lastMessageAt: 0, messageCount: 1 },
          ],
        },
        {
          channelHistory: [
            { channelType: "telegram", firstMessageAt: 0, lastMessageAt: 0, messageCount: 1 },
          ],
        },
      ),
    ).toBe(false);
  });

  it("should not match across different channel types", () => {
    expect(
      sessionsMatchPerson(
        {
          channelHistory: [
            {
              channelType: "telegram",
              firstMessageAt: 0,
              lastMessageAt: 0,
              messageCount: 1,
              channelUserId: "123",
            },
          ],
        },
        {
          channelHistory: [
            {
              channelType: "slack",
              firstMessageAt: 0,
              lastMessageAt: 0,
              messageCount: 1,
              channelUserId: "123",
            },
          ],
        },
      ),
    ).toBe(false);
  });

  it("should handle empty histories", () => {
    expect(sessionsMatchPerson({}, {})).toBe(false);
    expect(sessionsMatchPerson({ channelHistory: [] }, { channelHistory: [] })).toBe(false);
  });
});
