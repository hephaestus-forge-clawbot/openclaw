/**
 * User Identity Mapping (Hephie Phase 3.1)
 *
 * Maps users across channels: Telegram ID ↔ Slack ID ↔ WhatsApp number, etc.
 * Reads identity mappings from person files (memory/people/<name>.md) and
 * provides lookup by channel-specific user ID.
 */

import type { ChannelIdentity, ChannelType, UserIdentityMap } from "./types.js";

/**
 * In-memory identity store. Maps channel-specific user IDs to canonical names.
 *
 * Usage:
 *   1. Load identities from person files at startup
 *   2. Look up canonical name when a message arrives
 *   3. Find all sessions for a user across channels
 */
export class IdentityStore {
  /** Map from "channelType:userId" to canonical name. */
  private byChannelId: Map<string, string> = new Map();

  /** Map from canonical name to full identity map. */
  private byName: Map<string, UserIdentityMap> = new Map();

  /**
   * Register a user identity mapping.
   */
  registerIdentity(canonicalName: string, identity: ChannelIdentity): void {
    const name = canonicalName.toLowerCase().trim();
    if (!name || !identity.userId) {
      return;
    }

    const key = makeKey(identity.channelType, identity.userId);
    this.byChannelId.set(key, name);

    const existing = this.byName.get(name);
    if (existing) {
      // Update or add the identity
      const idx = existing.identities.findIndex(
        (i) => i.channelType === identity.channelType && i.userId === identity.userId,
      );
      if (idx >= 0) {
        existing.identities[idx] = { ...existing.identities[idx], ...identity };
      } else {
        existing.identities.push({ ...identity });
      }
      existing.updatedAt = Date.now();
    } else {
      this.byName.set(name, {
        canonicalName: name,
        identities: [{ ...identity }],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }

  /**
   * Register multiple identities for a user at once.
   */
  registerUser(canonicalName: string, identities: ChannelIdentity[]): void {
    for (const identity of identities) {
      this.registerIdentity(canonicalName, identity);
    }
  }

  /**
   * Look up the canonical name for a channel-specific user ID.
   */
  lookupByChannelId(channelType: ChannelType, userId: string): string | undefined {
    const key = makeKey(channelType, userId);
    return this.byChannelId.get(key);
  }

  /**
   * Get the full identity map for a canonical name.
   */
  getIdentityMap(canonicalName: string): UserIdentityMap | undefined {
    return this.byName.get(canonicalName.toLowerCase().trim());
  }

  /**
   * Get all channel IDs for a user on a specific channel type.
   */
  getChannelIds(canonicalName: string, channelType: ChannelType): string[] {
    const map = this.getIdentityMap(canonicalName);
    if (!map) {
      return [];
    }
    return map.identities.filter((i) => i.channelType === channelType).map((i) => i.userId);
  }

  /**
   * Get all channels a user is known on.
   */
  getKnownChannels(canonicalName: string): ChannelType[] {
    const map = this.getIdentityMap(canonicalName);
    if (!map) {
      return [];
    }
    return [...new Set(map.identities.map((i) => i.channelType))];
  }

  /**
   * Check if a user has an identity on a specific channel.
   */
  hasIdentity(canonicalName: string, channelType: ChannelType): boolean {
    const map = this.getIdentityMap(canonicalName);
    if (!map) {
      return false;
    }
    return map.identities.some((i) => i.channelType === channelType);
  }

  /**
   * Get total number of registered users.
   */
  getUserCount(): number {
    return this.byName.size;
  }

  /**
   * Get total number of identity mappings.
   */
  getIdentityCount(): number {
    return this.byChannelId.size;
  }

  /**
   * Get all registered users.
   */
  getAllUsers(): UserIdentityMap[] {
    return Array.from(this.byName.values());
  }

  /**
   * Remove a user and all their identities.
   */
  removeUser(canonicalName: string): boolean {
    const name = canonicalName.toLowerCase().trim();
    const map = this.byName.get(name);
    if (!map) {
      return false;
    }

    for (const identity of map.identities) {
      const key = makeKey(identity.channelType, identity.userId);
      this.byChannelId.delete(key);
    }
    this.byName.delete(name);
    return true;
  }

  /**
   * Clear all identity mappings.
   */
  clear(): void {
    this.byChannelId.clear();
    this.byName.clear();
  }
}

/**
 * Parse identity mappings from a person file's content.
 *
 * Looks for an `## Identities` section with entries like:
 *   - Telegram: 12345678
 *   - Slack: U02AY4DH803
 *   - WhatsApp: +44123456789
 *   - Discord: username#1234 or Discord: 123456789012345678
 *
 * Also handles YAML-style frontmatter:
 *   identities:
 *     telegram: "12345678"
 *     slack: "U02AY4DH803"
 */
export function parseIdentitiesFromPersonFile(content: string): ChannelIdentity[] {
  const identities: ChannelIdentity[] = [];

  // Strategy 1: Look for "## Identities" section with markdown list
  const identitiesSectionMatch = content.match(
    /##\s*Identities\s*\n([\s\S]*?)(?=\n##\s|\n---|Z|$)/i,
  );
  if (identitiesSectionMatch) {
    const section = identitiesSectionMatch[1];
    const lines = section.split("\n");
    for (const line of lines) {
      const identity = parseIdentityLine(line);
      if (identity) {
        identities.push(identity);
      }
    }
  }

  // Strategy 2: Look for YAML frontmatter with identities block
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const fm = frontmatterMatch[1];
    const identitiesBlockMatch = fm.match(/identities:\s*\n((?:\s+\w+:.*\n?)*)/i);
    if (identitiesBlockMatch) {
      const block = identitiesBlockMatch[1];
      const lines = block.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx > 0) {
          const channelType = trimmed.slice(0, colonIdx).trim().toLowerCase();
          const userId = trimmed
            .slice(colonIdx + 1)
            .trim()
            .replace(/^["']|["']$/g, "");
          if (channelType && userId) {
            identities.push({ channelType, userId });
          }
        }
      }
    }
  }

  // Strategy 3: Look for inline mentions like "Telegram ID: 12345"
  const inlinePatterns = [
    /telegram\s*(?:id|user)?:\s*(\d+)/gi,
    /slack\s*(?:id|user)?:\s*(U[A-Z0-9]+)/gi,
    /whatsapp\s*(?:number|phone)?:\s*(\+?\d[\d\s-]+)/gi,
    /discord\s*(?:id|user)?:\s*(\d{15,}|[\w.]+#\d{4})/gi,
    /signal\s*(?:number|phone)?:\s*(\+?\d[\d\s-]+)/gi,
  ];

  const channelNames: ChannelType[] = ["telegram", "slack", "whatsapp", "discord", "signal"];

  for (let i = 0; i < inlinePatterns.length; i++) {
    const pattern = inlinePatterns[i];
    const channelType = channelNames[i];
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const userId = match[1].trim().replace(/[\s-]/g, "");
      // Avoid duplicates
      if (!identities.some((id) => id.channelType === channelType && id.userId === userId)) {
        identities.push({ channelType, userId });
      }
    }
  }

  return identities;
}

/**
 * Generate the `## Identities` markdown section from identity entries.
 */
export function formatIdentitiesSection(identities: ChannelIdentity[]): string {
  if (identities.length === 0) {
    return "";
  }

  const lines = ["## Identities", ""];
  for (const identity of identities) {
    const label = identity.channelType.charAt(0).toUpperCase() + identity.channelType.slice(1);
    let value = identity.userId;
    if (identity.username) {
      value += ` (@${identity.username})`;
    }
    if (identity.displayName) {
      value += ` — ${identity.displayName}`;
    }
    lines.push(`- ${label}: ${value}`);
  }

  return lines.join("\n");
}

/**
 * Parse a single identity line from markdown.
 * Expected format: `- ChannelType: userId (@username)`
 */
function parseIdentityLine(line: string): ChannelIdentity | null {
  const match = line.match(
    /^[-*]\s*(telegram|slack|discord|whatsapp|signal|imessage|line|webchat)\s*:\s*(.+)/i,
  );
  if (!match) {
    return null;
  }

  const channelType = match[1].toLowerCase();
  let rest = match[2].trim();

  // Extract optional username in parentheses
  let username: string | undefined;
  const usernameMatch = rest.match(/\([@]?([\w.]+)\)/);
  if (usernameMatch) {
    username = usernameMatch[1];
    rest = rest.replace(/\s*\([@]?[\w.]+\)/, "").trim();
  }

  // Extract optional display name after dash
  let displayName: string | undefined;
  const dashIdx = rest.indexOf("—");
  if (dashIdx > 0) {
    displayName = rest.slice(dashIdx + 1).trim();
    rest = rest.slice(0, dashIdx).trim();
  }

  const userId = rest.trim();
  if (!userId) {
    return null;
  }

  return { channelType, userId, username, displayName };
}

/**
 * Create a lookup key from channel type and user ID.
 */
function makeKey(channelType: ChannelType, userId: string): string {
  return `${channelType.toLowerCase()}:${userId}`;
}
