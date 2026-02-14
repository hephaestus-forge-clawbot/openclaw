/**
 * Tests for Cross-Channel + Context Injector Integration (Hephie Phase 3.1)
 */

import { describe, expect, it } from "vitest";
import type { CrossChannelContext } from "./types.js";
import {
  buildCrossChannelSection,
  shouldInjectCrossChannelContext,
} from "./context-injector-integration.js";

describe("buildCrossChannelSection", () => {
  it("should build a section from cross-channel context", () => {
    const context: CrossChannelContext = {
      currentUser: "alice",
      currentChannel: "telegram",
      enabled: true,
      otherChannelActivity: [
        {
          channelType: "slack",
          timestamp: Date.now() - 30 * 60 * 1000,
          summary: "discussing ML experiments",
          sessionKey: "session-1",
          relevance: 0.9,
        },
      ],
      formattedContext:
        "[Cross-Channel Context for alice]\n- Slack (30m ago): discussing ML experiments",
    };

    const section = buildCrossChannelSection(context);
    expect(section).not.toBeNull();
    expect(section!.header).toBe("## Cross-Channel Activity");
    expect(section!.tier).toBe("system");
    expect(section!.content).toContain("Cross-Channel Context for alice");
    expect(section!.content).toContain("Slack");
    expect(section!.tokenCount).toBeGreaterThan(0);
  });

  it("should return null when disabled", () => {
    const context: CrossChannelContext = {
      currentUser: "alice",
      currentChannel: "telegram",
      enabled: false,
      otherChannelActivity: [],
      formattedContext: "",
    };

    expect(buildCrossChannelSection(context)).toBeNull();
  });

  it("should return null when no activity", () => {
    const context: CrossChannelContext = {
      currentUser: "alice",
      currentChannel: "telegram",
      enabled: true,
      otherChannelActivity: [],
      formattedContext: "",
    };

    expect(buildCrossChannelSection(context)).toBeNull();
  });
});

describe("shouldInjectCrossChannelContext", () => {
  it("should allow injection for same person", () => {
    expect(
      shouldInjectCrossChannelContext({
        enabled: true,
        currentPerson: "alice",
        crossChannelPerson: "alice",
        respectPrivacy: true,
      }),
    ).toBe(true);
  });

  it("should be case-insensitive for person matching", () => {
    expect(
      shouldInjectCrossChannelContext({
        enabled: true,
        currentPerson: "Alice",
        crossChannelPerson: "alice",
        respectPrivacy: true,
      }),
    ).toBe(true);
  });

  it("should deny injection for different person with privacy", () => {
    expect(
      shouldInjectCrossChannelContext({
        enabled: true,
        currentPerson: "alice",
        crossChannelPerson: "bob",
        respectPrivacy: true,
      }),
    ).toBe(false);
  });

  it("should allow injection for different person without privacy", () => {
    expect(
      shouldInjectCrossChannelContext({
        enabled: true,
        currentPerson: "alice",
        crossChannelPerson: "bob",
        respectPrivacy: false,
      }),
    ).toBe(true);
  });

  it("should deny when disabled", () => {
    expect(
      shouldInjectCrossChannelContext({
        enabled: false,
        currentPerson: "alice",
        crossChannelPerson: "alice",
        respectPrivacy: true,
      }),
    ).toBe(false);
  });

  it("should deny without currentPerson", () => {
    expect(
      shouldInjectCrossChannelContext({
        enabled: true,
        currentPerson: undefined,
        crossChannelPerson: "alice",
        respectPrivacy: true,
      }),
    ).toBe(false);
  });

  it("should deny without crossChannelPerson", () => {
    expect(
      shouldInjectCrossChannelContext({
        enabled: true,
        currentPerson: "alice",
        crossChannelPerson: undefined,
        respectPrivacy: true,
      }),
    ).toBe(false);
  });
});
