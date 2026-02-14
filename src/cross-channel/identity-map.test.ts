/**
 * Tests for User Identity Mapping (Hephie Phase 3.1)
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  IdentityStore,
  parseIdentitiesFromPersonFile,
  formatIdentitiesSection,
} from "./identity-map.js";

describe("IdentityStore", () => {
  let store: IdentityStore;

  beforeEach(() => {
    store = new IdentityStore();
  });

  it("should start empty", () => {
    expect(store.getUserCount()).toBe(0);
    expect(store.getIdentityCount()).toBe(0);
  });

  it("should register and look up a single identity", () => {
    store.registerIdentity("alice", {
      channelType: "telegram",
      userId: "123456",
    });

    expect(store.lookupByChannelId("telegram", "123456")).toBe("alice");
    expect(store.getUserCount()).toBe(1);
    expect(store.getIdentityCount()).toBe(1);
  });

  it("should register multiple identities for one user", () => {
    store.registerUser("alice", [
      { channelType: "telegram", userId: "123456" },
      { channelType: "slack", userId: "U02AY4DH803" },
      { channelType: "whatsapp", userId: "+44123456789" },
    ]);

    expect(store.lookupByChannelId("telegram", "123456")).toBe("alice");
    expect(store.lookupByChannelId("slack", "U02AY4DH803")).toBe("alice");
    expect(store.lookupByChannelId("whatsapp", "+44123456789")).toBe("alice");
    expect(store.getUserCount()).toBe(1);
    expect(store.getIdentityCount()).toBe(3);
  });

  it("should handle multiple users", () => {
    store.registerIdentity("alice", { channelType: "telegram", userId: "111" });
    store.registerIdentity("bob", { channelType: "telegram", userId: "222" });

    expect(store.lookupByChannelId("telegram", "111")).toBe("alice");
    expect(store.lookupByChannelId("telegram", "222")).toBe("bob");
    expect(store.getUserCount()).toBe(2);
  });

  it("should return undefined for unknown user", () => {
    expect(store.lookupByChannelId("telegram", "999")).toBeUndefined();
  });

  it("should normalize canonical names to lowercase", () => {
    store.registerIdentity("Alice", { channelType: "telegram", userId: "123" });
    expect(store.lookupByChannelId("telegram", "123")).toBe("alice");
    expect(store.getIdentityMap("ALICE")).toBeDefined();
  });

  it("should get full identity map for a user", () => {
    store.registerUser("alice", [
      { channelType: "telegram", userId: "123", username: "alice_tg" },
      { channelType: "slack", userId: "U123", displayName: "Alice" },
    ]);

    const map = store.getIdentityMap("alice");
    expect(map?.canonicalName).toBe("alice");
    expect(map?.identities).toHaveLength(2);
    expect(map?.identities[0].username).toBe("alice_tg");
    expect(map?.identities[1].displayName).toBe("Alice");
  });

  it("should get channel IDs for a specific channel type", () => {
    store.registerUser("alice", [
      { channelType: "telegram", userId: "123" },
      { channelType: "slack", userId: "U123" },
    ]);

    expect(store.getChannelIds("alice", "telegram")).toEqual(["123"]);
    expect(store.getChannelIds("alice", "slack")).toEqual(["U123"]);
    expect(store.getChannelIds("alice", "discord")).toEqual([]);
  });

  it("should get known channels for a user", () => {
    store.registerUser("alice", [
      { channelType: "telegram", userId: "123" },
      { channelType: "slack", userId: "U123" },
    ]);

    const channels = store.getKnownChannels("alice");
    expect(channels).toContain("telegram");
    expect(channels).toContain("slack");
    expect(channels).toHaveLength(2);
  });

  it("should check if user has identity on channel", () => {
    store.registerIdentity("alice", { channelType: "telegram", userId: "123" });

    expect(store.hasIdentity("alice", "telegram")).toBe(true);
    expect(store.hasIdentity("alice", "slack")).toBe(false);
  });

  it("should update existing identity rather than duplicate", () => {
    store.registerIdentity("alice", {
      channelType: "telegram",
      userId: "123",
      username: "old",
    });
    store.registerIdentity("alice", {
      channelType: "telegram",
      userId: "123",
      username: "new",
    });

    const map = store.getIdentityMap("alice");
    expect(map?.identities).toHaveLength(1);
    expect(map?.identities[0].username).toBe("new");
  });

  it("should remove a user and all their identities", () => {
    store.registerUser("alice", [
      { channelType: "telegram", userId: "123" },
      { channelType: "slack", userId: "U123" },
    ]);

    expect(store.removeUser("alice")).toBe(true);
    expect(store.getUserCount()).toBe(0);
    expect(store.getIdentityCount()).toBe(0);
    expect(store.lookupByChannelId("telegram", "123")).toBeUndefined();
  });

  it("should return false when removing non-existent user", () => {
    expect(store.removeUser("nobody")).toBe(false);
  });

  it("should clear all data", () => {
    store.registerUser("alice", [{ channelType: "telegram", userId: "123" }]);
    store.registerUser("bob", [{ channelType: "slack", userId: "U456" }]);

    store.clear();
    expect(store.getUserCount()).toBe(0);
    expect(store.getIdentityCount()).toBe(0);
  });

  it("should get all registered users", () => {
    store.registerIdentity("alice", { channelType: "telegram", userId: "123" });
    store.registerIdentity("bob", { channelType: "slack", userId: "U456" });

    const users = store.getAllUsers();
    expect(users).toHaveLength(2);
    const names = users.map((u) => u.canonicalName);
    expect(names).toContain("alice");
    expect(names).toContain("bob");
  });

  it("should ignore empty userId or name", () => {
    store.registerIdentity("", { channelType: "telegram", userId: "123" });
    store.registerIdentity("alice", { channelType: "telegram", userId: "" });

    expect(store.getUserCount()).toBe(0);
    expect(store.getIdentityCount()).toBe(0);
  });
});

describe("parseIdentitiesFromPersonFile", () => {
  it("should parse ## Identities section", () => {
    const content = `# Alice

Some info about Alice.

## Identities

- Telegram: 123456
- Slack: U02AY4DH803
- WhatsApp: +44123456789

## Notes

Other stuff.
`;

    const identities = parseIdentitiesFromPersonFile(content);
    expect(identities).toHaveLength(3);
    expect(identities[0]).toMatchObject({ channelType: "telegram", userId: "123456" });
    expect(identities[1]).toMatchObject({ channelType: "slack", userId: "U02AY4DH803" });
    expect(identities[2]).toMatchObject({ channelType: "whatsapp", userId: "+44123456789" });
  });

  it("should parse identities with username and display name", () => {
    const content = `## Identities

- Telegram: 123456 (@alice_tg) — Alice T
- Discord: 987654321012345678
`;

    const identities = parseIdentitiesFromPersonFile(content);
    expect(identities.length).toBeGreaterThanOrEqual(2);
    const tg = identities.find((i) => i.channelType === "telegram");
    expect(tg?.username).toBe("alice_tg");
    expect(tg?.displayName).toBe("Alice T");
  });

  it("should parse inline identity mentions", () => {
    const content = `# Alice

Met on Telegram. Her Telegram ID: 5139254502
Also on Slack ID: U02AY4DH803
WhatsApp number: +447123456789
`;

    const identities = parseIdentitiesFromPersonFile(content);
    expect(identities.length).toBeGreaterThanOrEqual(3);

    const tg = identities.find((i) => i.channelType === "telegram");
    expect(tg?.userId).toBe("5139254502");

    const slack = identities.find((i) => i.channelType === "slack");
    expect(slack?.userId).toBe("U02AY4DH803");

    const wa = identities.find((i) => i.channelType === "whatsapp");
    expect(wa?.userId).toBe("+447123456789");
  });

  it("should parse YAML frontmatter identities", () => {
    const content = `---
name: Alice
identities:
  telegram: "123456"
  slack: "U02AY4DH803"
---

# Alice
`;

    const identities = parseIdentitiesFromPersonFile(content);
    expect(identities.length).toBeGreaterThanOrEqual(2);
    expect(identities.find((i) => i.channelType === "telegram")?.userId).toBe("123456");
    expect(identities.find((i) => i.channelType === "slack")?.userId).toBe("U02AY4DH803");
  });

  it("should return empty for files without identities", () => {
    const content = `# Bob

Just a regular person file with no identity info.
`;

    const identities = parseIdentitiesFromPersonFile(content);
    expect(identities).toHaveLength(0);
  });

  it("should deduplicate identities from multiple strategies", () => {
    const content = `## Identities

- Telegram: 123456

Also mentioned: Telegram ID: 123456
`;

    const identities = parseIdentitiesFromPersonFile(content);
    const telegramIds = identities.filter((i) => i.channelType === "telegram");
    expect(telegramIds).toHaveLength(1);
  });
});

describe("formatIdentitiesSection", () => {
  it("should format identities as markdown section", () => {
    const result = formatIdentitiesSection([
      { channelType: "telegram", userId: "123456" },
      { channelType: "slack", userId: "U02AY4DH803" },
    ]);

    expect(result).toContain("## Identities");
    expect(result).toContain("- Telegram: 123456");
    expect(result).toContain("- Slack: U02AY4DH803");
  });

  it("should include username and display name", () => {
    const result = formatIdentitiesSection([
      {
        channelType: "telegram",
        userId: "123456",
        username: "alice_tg",
        displayName: "Alice",
      },
    ]);

    expect(result).toContain("(@alice_tg)");
    expect(result).toContain("— Alice");
  });

  it("should return empty string for no identities", () => {
    expect(formatIdentitiesSection([])).toBe("");
  });
});
