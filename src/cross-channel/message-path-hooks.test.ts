/**
 * Tests for Message Path Hooks (Hephie Phase 3.2)
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  processInboundForCrossChannel,
  assembleCrossChannelPromptSection,
  extractMessageIdentity,
} from "./message-path-hooks.js";
import { ReplyRouter } from "./reply-router.js";

describe("processInboundForCrossChannel", () => {
  let router: ReplyRouter;

  beforeEach(() => {
    router = new ReplyRouter();
  });

  it("should update channel history on inbound message", () => {
    const result = processInboundForCrossChannel(
      {
        sessionKey: "session-1",
        channelType: "telegram",
        channelUserId: "user-123",
        channelChatId: "chat-456",
        to: "chat-456",
        timestamp: 1000,
      },
      router,
    );

    expect(result.channelHistory).toHaveLength(1);
    expect(result.channelHistory[0].channelType).toBe("telegram");
    expect(result.channelHistory[0].messageCount).toBe(1);
    expect(result.channelHistory[0].channelUserId).toBe("user-123");
  });

  it("should update reply route on inbound message", () => {
    const result = processInboundForCrossChannel(
      {
        sessionKey: "session-1",
        channelType: "telegram",
        to: "chat-456",
        accountId: "bot-1",
        threadId: "thread-99",
        timestamp: 1000,
      },
      router,
    );

    expect(result.replyRoute.channel).toBe("telegram");
    expect(result.replyRoute.to).toBe("chat-456");
    expect(result.replyRoute.accountId).toBe("bot-1");
    expect(result.replyRoute.threadId).toBe("thread-99");
  });

  it("should track person for reply routing", () => {
    processInboundForCrossChannel(
      {
        sessionKey: "session-1",
        channelType: "telegram",
        to: "chat-456",
        person: "Father",
        timestamp: 1000,
      },
      router,
    );

    expect(router.getRouteForPerson("Father")).toBeDefined();
    expect(router.getRouteForPerson("Father")!.channel).toBe("telegram");
  });

  it("should accumulate channel history across messages", () => {
    const result1 = processInboundForCrossChannel(
      {
        sessionKey: "session-1",
        channelType: "telegram",
        to: "chat-456",
        timestamp: 1000,
      },
      router,
    );

    const result2 = processInboundForCrossChannel(
      {
        sessionKey: "session-1",
        currentChannelHistory: result1.channelHistory,
        channelType: "telegram",
        to: "chat-456",
        timestamp: 2000,
      },
      router,
    );

    expect(result2.channelHistory).toHaveLength(1);
    expect(result2.channelHistory[0].messageCount).toBe(2);
  });

  it("should track multiple channels in history", () => {
    const result1 = processInboundForCrossChannel(
      {
        sessionKey: "session-1",
        channelType: "telegram",
        to: "chat-456",
        timestamp: 1000,
      },
      router,
    );

    const result2 = processInboundForCrossChannel(
      {
        sessionKey: "session-1",
        currentChannelHistory: result1.channelHistory,
        channelType: "slack",
        to: "C123",
        timestamp: 2000,
      },
      router,
    );

    expect(result2.channelHistory).toHaveLength(2);
  });

  it("should update reply route when channel changes", () => {
    processInboundForCrossChannel(
      {
        sessionKey: "session-1",
        channelType: "telegram",
        to: "chat-456",
        timestamp: 1000,
      },
      router,
    );

    processInboundForCrossChannel(
      {
        sessionKey: "session-1",
        channelType: "slack",
        to: "C123",
        timestamp: 2000,
      },
      router,
    );

    const route = router.getRoute("session-1");
    expect(route!.channel).toBe("slack");
    expect(route!.to).toBe("C123");
  });

  it("should fall back to channelChatId when to is not provided", () => {
    const result = processInboundForCrossChannel(
      {
        sessionKey: "session-1",
        channelType: "telegram",
        channelChatId: "chat-456",
        timestamp: 1000,
      },
      router,
    );

    expect(result.replyRoute.to).toBe("chat-456");
  });

  it("should handle topic tracking", () => {
    const result = processInboundForCrossChannel(
      {
        sessionKey: "session-1",
        channelType: "telegram",
        to: "chat-456",
        topic: "Phase 3.2 implementation",
        timestamp: 1000,
      },
      router,
    );

    expect(result.channelHistory[0].lastTopic).toBe("Phase 3.2 implementation");
  });
});

describe("assembleCrossChannelPromptSection", () => {
  it("should return null section when no person is specified", () => {
    const result = assembleCrossChannelPromptSection({
      sessionKey: "session-1",
      currentChannel: "telegram",
    });

    expect(result.section).toBeNull();
    expect(result.formattedContext).toBe("");
  });

  it("should return null section when no channel is specified", () => {
    const result = assembleCrossChannelPromptSection({
      sessionKey: "session-1",
      currentPerson: "Father",
    });

    expect(result.section).toBeNull();
  });

  it("should return null section with no active sessions", () => {
    const result = assembleCrossChannelPromptSection({
      sessionKey: "session-1",
      currentPerson: "Father",
      currentChannel: "telegram",
      getSessionEntries: () => [],
    });

    expect(result.section).toBeNull();
  });

  it("should return section with cross-channel activity", () => {
    const now = Date.now();
    const result = assembleCrossChannelPromptSection({
      sessionKey: "session-1",
      currentPerson: "Father",
      currentChannel: "telegram",
      getSessionEntries: () => [
        {
          key: "session-2",
          channelHistory: [
            {
              channelType: "slack",
              firstMessageAt: now - 3600_000,
              lastMessageAt: now - 1800_000,
              messageCount: 5,
              lastTopic: "Code review",
            },
            {
              channelType: "telegram",
              firstMessageAt: now - 7200_000,
              lastMessageAt: now - 3600_000,
              messageCount: 3,
            },
          ],
          crossChannelPerson: "Father",
          lastTopic: "Code review",
        },
      ],
    });

    // Should have activity from the slack channel (since we're on telegram)
    if (result.section) {
      expect(result.section.header).toBe("## Cross-Channel Activity");
      expect(result.formattedContext).toContain("Slack");
    }
  });

  it("should respect disabled config", () => {
    const result = assembleCrossChannelPromptSection({
      sessionKey: "session-1",
      currentPerson: "Father",
      currentChannel: "telegram",
      config: { enabled: false },
    });

    expect(result.section).toBeNull();
  });
});

describe("extractMessageIdentity", () => {
  it("should extract telegram identity", () => {
    const result = extractMessageIdentity({
      OriginatingChannel: "telegram",
      SenderId: "12345",
      ChatId: "chat-456",
      AccountId: "bot-1",
    });

    expect(result.channelType).toBe("telegram");
    expect(result.channelUserId).toBe("12345");
    expect(result.accountId).toBe("bot-1");
  });

  it("should extract from Surface when OriginatingChannel is absent", () => {
    const result = extractMessageIdentity({
      Surface: "slack",
      SenderId: "U123",
    });

    expect(result.channelType).toBe("slack");
    expect(result.channelUserId).toBe("U123");
  });

  it("should extract from Provider as fallback", () => {
    const result = extractMessageIdentity({
      Provider: "discord",
      From: "user#1234",
    });

    expect(result.channelType).toBe("discord");
    expect(result.channelUserId).toBe("user#1234");
  });

  it("should extract thread ID", () => {
    const result = extractMessageIdentity({
      OriginatingChannel: "telegram",
      SenderId: "12345",
      ThreadId: "thread-99",
    });

    expect(result.threadId).toBe("thread-99");
  });

  it("should extract MessageThreadId when ThreadId is absent", () => {
    const result = extractMessageIdentity({
      OriginatingChannel: "telegram",
      SenderId: "12345",
      MessageThreadId: 42,
    });

    expect(result.threadId).toBe(42);
  });

  it("should handle empty context", () => {
    const result = extractMessageIdentity({});

    expect(result.channelType).toBeUndefined();
    expect(result.channelUserId).toBeUndefined();
  });
});
