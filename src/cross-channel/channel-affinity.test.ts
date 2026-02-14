/**
 * Channel Affinity Mapping Tests (Hephie Phase 3.4)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ChannelAffinityMapper } from "./channel-affinity.js";

describe("ChannelAffinityMapper", () => {
  let mapper: ChannelAffinityMapper;

  beforeEach(() => {
    mapper = new ChannelAffinityMapper();
  });

  // ── Default Rules ───────────────────────────────────────────────────

  it("loads default affinity rules", () => {
    expect(mapper.ruleCount).toBeGreaterThan(0);
    const codeRule = mapper.getRule("code");
    expect(codeRule).toBeDefined();
    expect(codeRule!.preferredChannels).toContain("slack");
  });

  it("code prefers Slack and Discord", () => {
    const rule = mapper.getRule("code");
    expect(rule!.preferredChannels).toEqual(["slack", "discord"]);
    expect(rule!.avoidChannels).toContain("whatsapp");
  });

  it("file prefers Telegram over WhatsApp", () => {
    const rule = mapper.getRule("file");
    expect(rule!.preferredChannels[0]).toBe("telegram");
    expect(rule!.avoidChannels).toContain("whatsapp");
  });

  it("acknowledgment has empty preferred (use most recent)", () => {
    const rule = mapper.getRule("acknowledgment");
    expect(rule!.preferredChannels).toEqual([]);
  });

  // ── Affinity Scoring ───────────────────────────────────────────────

  it("scores preferred channel highest", () => {
    const score = mapper.computeAffinityScore("slack", "code");
    expect(score).toBe(1.0);
  });

  it("scores second-preferred channel lower", () => {
    const score = mapper.computeAffinityScore("discord", "code");
    expect(score).toBe(0.85);
  });

  it("scores avoided channel as 0", () => {
    const score = mapper.computeAffinityScore("whatsapp", "code");
    expect(score).toBe(0.0);
  });

  it("scores neutral channel as 0.3", () => {
    const score = mapper.computeAffinityScore("telegram", "code");
    expect(score).toBe(0.3);
  });

  it("scores 0.5 for no message type", () => {
    const score = mapper.computeAffinityScore("telegram", undefined);
    expect(score).toBe(0.5);
  });

  it("scores 0.5 for unknown message type", () => {
    const score = mapper.computeAffinityScore("telegram", "custom-type");
    expect(score).toBe(0.5);
  });

  it("scores 0.5 when preferred list is empty", () => {
    const score = mapper.computeAffinityScore("telegram", "acknowledgment");
    expect(score).toBe(0.5);
  });

  // ── Best Channels ──────────────────────────────────────────────────

  it("ranks channels by affinity for code", () => {
    const available = ["telegram", "slack", "discord", "whatsapp"];
    const ranked = mapper.getBestChannels("code", available);

    expect(ranked[0]).toBe("slack");
    expect(ranked[1]).toBe("discord");
    expect(ranked).not.toContain("whatsapp"); // avoided
  });

  it("returns all channels when no rule exists", () => {
    const available = ["telegram", "slack", "discord"];
    const ranked = mapper.getBestChannels("unknown-type", available);
    expect(ranked).toHaveLength(3);
  });

  // ── Avoid Check ─────────────────────────────────────────────────────

  it("shouldAvoid returns true for avoided channels", () => {
    expect(mapper.shouldAvoid("whatsapp", "code")).toBe(true);
  });

  it("shouldAvoid returns false for non-avoided channels", () => {
    expect(mapper.shouldAvoid("slack", "code")).toBe(false);
  });

  it("shouldAvoid returns false for unknown message type", () => {
    expect(mapper.shouldAvoid("whatsapp", "unknown")).toBe(false);
  });

  // ── Affinity Reasons ───────────────────────────────────────────────

  it("returns reason for top choice", () => {
    const reason = mapper.getAffinityReason("slack", "code");
    expect(reason).toContain("top choice");
    expect(reason).toContain("code");
  });

  it("returns reason for avoided channel", () => {
    const reason = mapper.getAffinityReason("whatsapp", "code");
    expect(reason).toContain("avoided");
  });

  it("returns reason for non-top preferred channel", () => {
    const reason = mapper.getAffinityReason("discord", "code");
    expect(reason).toContain("preferred (#2)");
  });

  it("returns null for no opinion", () => {
    expect(mapper.getAffinityReason("telegram", undefined)).toBeNull();
    expect(mapper.getAffinityReason("telegram", "unknown-type")).toBeNull();
  });

  // ── Custom Rules ────────────────────────────────────────────────────

  it("allows adding custom rules", () => {
    mapper.setRule({
      messageType: "meme",
      preferredChannels: ["discord", "telegram"],
      reason: "Meme-friendly platforms",
    });

    const rule = mapper.getRule("meme");
    expect(rule).toBeDefined();
    expect(rule!.preferredChannels).toEqual(["discord", "telegram"]);
  });

  it("allows removing rules", () => {
    expect(mapper.removeRule("code")).toBe(true);
    expect(mapper.getRule("code")).toBeUndefined();
  });

  it("replaces existing rules", () => {
    mapper.setRule({
      messageType: "code",
      preferredChannels: ["telegram"],
      reason: "Custom preference",
    });

    const rule = mapper.getRule("code");
    expect(rule!.preferredChannels).toEqual(["telegram"]);
  });

  // ── Custom config ───────────────────────────────────────────────────

  it("supports custom config with no default rules", () => {
    mapper = new ChannelAffinityMapper({
      rules: [
        {
          messageType: "custom",
          preferredChannels: ["webchat"],
          reason: "Custom",
        },
      ],
    });

    expect(mapper.ruleCount).toBe(1);
    expect(mapper.getRule("custom")).toBeDefined();
    expect(mapper.getRule("code")).toBeUndefined();
  });

  it("exposes config methods", () => {
    expect(mapper.getAffinityWeight()).toBe(0.3);
    expect(mapper.doesOverridePreferences()).toBe(false);

    mapper.setConfig({ overridePreferences: true, affinityWeight: 0.5 });
    expect(mapper.getAffinityWeight()).toBe(0.5);
    expect(mapper.doesOverridePreferences()).toBe(true);
  });

  it("clears all rules", () => {
    mapper.clear();
    expect(mapper.ruleCount).toBe(0);
  });
});
