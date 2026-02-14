/**
 * Thread Storage (Hephie Phase 3.3)
 *
 * SQLite-backed persistent storage for unified threads and thread messages.
 * Reuses the memory SQLite infrastructure patterns from Phase 2.
 */

import { randomUUID } from "node:crypto";
import type {
  UnifiedThread,
  ThreadMessage,
  ThreadStatus,
  ThreadSearchCriteria,
  PlatformThreadMapping,
} from "./thread-types.js";
import type { ChannelType } from "./types.js";

/**
 * Minimal interface for SQLite database operations.
 * Compatible with node:sqlite DatabaseSync.
 */
export interface ThreadDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

// ── Schema ──────────────────────────────────────────────────────────────

/**
 * Create the unified_threads table.
 */
export function createThreadsTable(db: ThreadDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unified_threads (
      thread_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open', 'active', 'stale', 'closed', 'archived')),
      topic TEXT,
      summary TEXT,
      decisions TEXT,
      action_items TEXT,
      participants TEXT NOT NULL DEFAULT '[]',
      channels TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER,
      metadata TEXT
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_ut_status ON unified_threads(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ut_updated_at ON unified_threads(updated_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ut_created_at ON unified_threads(created_at);`);
}

/**
 * Create the thread_messages table.
 */
export function createThreadMessagesTable(db: ThreadDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      platform_message_id TEXT,
      channel_chat_id TEXT,
      sender TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      link_type TEXT NOT NULL DEFAULT 'explicit'
        CHECK(link_type IN ('explicit', 'implicit', 'platform', 'reply')),
      metadata TEXT,
      FOREIGN KEY (thread_id) REFERENCES unified_threads(thread_id) ON DELETE CASCADE
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_tm_thread_id ON thread_messages(thread_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tm_sender ON thread_messages(sender);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tm_timestamp ON thread_messages(timestamp);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tm_channel_type ON thread_messages(channel_type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tm_platform_id ON thread_messages(platform_message_id);`);
}

/**
 * Create the platform_thread_mappings table.
 */
export function createPlatformMappingsTable(db: ThreadDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_thread_mappings (
      thread_id TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      platform_thread_id TEXT NOT NULL,
      platform_chat_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (channel_type, platform_thread_id, platform_chat_id),
      FOREIGN KEY (thread_id) REFERENCES unified_threads(thread_id) ON DELETE CASCADE
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_ptm_thread_id ON platform_thread_mappings(thread_id);`);
}

/**
 * Initialize all threading tables.
 */
export function initializeThreadSchema(db: ThreadDatabase): void {
  createThreadsTable(db);
  createThreadMessagesTable(db);
  createPlatformMappingsTable(db);
}

// ── Row Types ───────────────────────────────────────────────────────────

interface ThreadRow {
  thread_id: string;
  status: string;
  topic: string | null;
  summary: string | null;
  decisions: string | null;
  action_items: string | null;
  participants: string;
  channels: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  metadata: string | null;
}

interface MessageRow {
  message_id: string;
  thread_id: string;
  channel_type: string;
  platform_message_id: string | null;
  channel_chat_id: string | null;
  sender: string;
  content: string;
  timestamp: number;
  link_type: string;
  metadata: string | null;
}

interface MappingRow {
  thread_id: string;
  channel_type: string;
  platform_thread_id: string;
  platform_chat_id: string;
  created_at: number;
}

// ── Converters ──────────────────────────────────────────────────────────

function rowToThread(row: ThreadRow): UnifiedThread {
  return {
    threadId: row.thread_id,
    status: row.status as ThreadStatus,
    topic: row.topic ?? undefined,
    summary: row.summary ?? undefined,
    decisions: row.decisions ? (JSON.parse(row.decisions) as string[]) : undefined,
    actionItems: row.action_items ? (JSON.parse(row.action_items) as string[]) : undefined,
    participants: JSON.parse(row.participants) as string[],
    channels: JSON.parse(row.channels) as ChannelType[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at ?? undefined,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
  };
}

function rowToMessage(row: MessageRow): ThreadMessage {
  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    channelType: row.channel_type as ChannelType,
    platformMessageId: row.platform_message_id ?? undefined,
    channelChatId: row.channel_chat_id ?? undefined,
    sender: row.sender,
    content: row.content,
    timestamp: row.timestamp,
    linkType: row.link_type as ThreadMessage["linkType"],
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
  };
}

function rowToMapping(row: MappingRow): PlatformThreadMapping {
  return {
    threadId: row.thread_id,
    channelType: row.channel_type as ChannelType,
    platformThreadId: row.platform_thread_id,
    platformChatId: row.platform_chat_id,
    createdAt: row.created_at,
  };
}

// ── Thread Store ────────────────────────────────────────────────────────

/**
 * Persistent store for unified threads, messages, and platform mappings.
 */
export class ThreadStore {
  private readonly db: ThreadDatabase;

  constructor(db: ThreadDatabase) {
    this.db = db;
    initializeThreadSchema(db);
  }

  // ── Thread CRUD ─────────────────────────────────────────────────────

  /**
   * Create a new unified thread.
   */
  createThread(params: {
    topic?: string;
    participants?: string[];
    channels?: ChannelType[];
    status?: ThreadStatus;
    metadata?: Record<string, unknown>;
    now?: number;
  }): UnifiedThread {
    const now = params.now ?? Date.now();
    const threadId = randomUUID();
    const status = params.status ?? "open";
    const participants = params.participants ?? [];
    const channels = params.channels ?? [];

    this.db
      .prepare(
        `INSERT INTO unified_threads
         (thread_id, status, topic, participants, channels, created_at, updated_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        threadId,
        status,
        params.topic ?? null,
        JSON.stringify(participants),
        JSON.stringify(channels),
        now,
        now,
        params.metadata ? JSON.stringify(params.metadata) : null,
      );

    return {
      threadId,
      status,
      topic: params.topic,
      participants,
      channels,
      createdAt: now,
      updatedAt: now,
      metadata: params.metadata,
    };
  }

  /**
   * Get a thread by ID (without messages).
   */
  getThread(threadId: string): UnifiedThread | null {
    const row = this.db
      .prepare(`SELECT * FROM unified_threads WHERE thread_id = ?`)
      .get(threadId) as ThreadRow | undefined;
    return row ? rowToThread(row) : null;
  }

  /**
   * Get a thread by ID with all its messages loaded.
   */
  getThreadWithMessages(threadId: string): UnifiedThread | null {
    const thread = this.getThread(threadId);
    if (!thread) {
      return null;
    }
    thread.messages = this.getMessages(threadId);
    return thread;
  }

  /**
   * Update a thread's properties.
   */
  updateThread(
    threadId: string,
    updates: Partial<
      Pick<
        UnifiedThread,
        | "status"
        | "topic"
        | "summary"
        | "decisions"
        | "actionItems"
        | "participants"
        | "channels"
        | "closedAt"
        | "metadata"
      >
    >,
    now?: number,
  ): boolean {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.topic !== undefined) {
      fields.push("topic = ?");
      values.push(updates.topic);
    }
    if (updates.summary !== undefined) {
      fields.push("summary = ?");
      values.push(updates.summary);
    }
    if (updates.decisions !== undefined) {
      fields.push("decisions = ?");
      values.push(JSON.stringify(updates.decisions));
    }
    if (updates.actionItems !== undefined) {
      fields.push("action_items = ?");
      values.push(JSON.stringify(updates.actionItems));
    }
    if (updates.participants !== undefined) {
      fields.push("participants = ?");
      values.push(JSON.stringify(updates.participants));
    }
    if (updates.channels !== undefined) {
      fields.push("channels = ?");
      values.push(JSON.stringify(updates.channels));
    }
    if (updates.closedAt !== undefined) {
      fields.push("closed_at = ?");
      values.push(updates.closedAt);
    }
    if (updates.metadata !== undefined) {
      fields.push("metadata = ?");
      values.push(JSON.stringify(updates.metadata));
    }

    // Always bump updated_at
    fields.push("updated_at = ?");
    values.push(now ?? Date.now());

    if (fields.length === 1) {
      // Only updated_at, nothing to change
      return false;
    }

    values.push(threadId);
    const result = this.db
      .prepare(`UPDATE unified_threads SET ${fields.join(", ")} WHERE thread_id = ?`)
      .run(...values);
    return result.changes > 0;
  }

  /**
   * Delete a thread and all its messages/mappings (cascading).
   */
  deleteThread(threadId: string): boolean {
    // Manual cascade since not all SQLite builds support FK cascade
    this.db.prepare(`DELETE FROM thread_messages WHERE thread_id = ?`).run(threadId);
    this.db.prepare(`DELETE FROM platform_thread_mappings WHERE thread_id = ?`).run(threadId);
    const result = this.db.prepare(`DELETE FROM unified_threads WHERE thread_id = ?`).run(threadId);
    return result.changes > 0;
  }

  // ── Message CRUD ────────────────────────────────────────────────────

  /**
   * Add a message to a thread.
   */
  addMessage(params: {
    threadId: string;
    channelType: ChannelType;
    sender: string;
    content: string;
    platformMessageId?: string;
    channelChatId?: string;
    linkType?: ThreadMessage["linkType"];
    timestamp?: number;
    metadata?: Record<string, unknown>;
  }): ThreadMessage {
    const now = params.timestamp ?? Date.now();
    const messageId = randomUUID();
    const linkType = params.linkType ?? "explicit";

    this.db
      .prepare(
        `INSERT INTO thread_messages
         (message_id, thread_id, channel_type, platform_message_id, channel_chat_id,
          sender, content, timestamp, link_type, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        messageId,
        params.threadId,
        params.channelType,
        params.platformMessageId ?? null,
        params.channelChatId ?? null,
        params.sender,
        params.content,
        now,
        linkType,
        params.metadata ? JSON.stringify(params.metadata) : null,
      );

    // Update thread's updated_at, participants, and channels
    const thread = this.getThread(params.threadId);
    if (thread) {
      const participants = new Set(thread.participants);
      participants.add(params.sender);
      const channels = new Set(thread.channels);
      channels.add(params.channelType);

      // Move to 'active' if currently 'open'
      const newStatus =
        thread.status === "open" && thread.messages && thread.messages.length > 0
          ? "active"
          : thread.status === "open"
            ? thread.status
            : thread.status;

      this.updateThread(
        params.threadId,
        {
          participants: [...participants],
          channels: [...channels],
          status: newStatus === "open" ? undefined : newStatus,
        },
        now,
      );
    }

    return {
      messageId,
      threadId: params.threadId,
      channelType: params.channelType,
      platformMessageId: params.platformMessageId,
      channelChatId: params.channelChatId,
      sender: params.sender,
      content: params.content,
      timestamp: now,
      linkType,
      metadata: params.metadata,
    };
  }

  /**
   * Get all messages in a thread, ordered by timestamp.
   */
  getMessages(threadId: string, limit?: number): ThreadMessage[] {
    let sql = `SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY timestamp ASC`;
    const params: unknown[] = [threadId];

    if (limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    const rows = this.db.prepare(sql).all(...params) as MessageRow[];
    return rows.map(rowToMessage);
  }

  /**
   * Get recent messages across all threads for a sender.
   */
  getRecentMessagesBySender(
    sender: string,
    opts?: { limit?: number; since?: number },
  ): ThreadMessage[] {
    const limit = opts?.limit ?? 50;
    const since = opts?.since ?? 0;

    const rows = this.db
      .prepare(
        `SELECT * FROM thread_messages
         WHERE sender = ? AND timestamp > ?
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(sender, since, limit) as MessageRow[];
    return rows.map(rowToMessage);
  }

  /**
   * Get recent messages across all threads on a channel.
   */
  getRecentMessagesByChannel(
    channelType: ChannelType,
    opts?: { limit?: number; since?: number },
  ): ThreadMessage[] {
    const limit = opts?.limit ?? 50;
    const since = opts?.since ?? 0;

    const rows = this.db
      .prepare(
        `SELECT * FROM thread_messages
         WHERE channel_type = ? AND timestamp > ?
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(channelType, since, limit) as MessageRow[];
    return rows.map(rowToMessage);
  }

  /**
   * Get the message count for a thread.
   */
  getMessageCount(threadId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM thread_messages WHERE thread_id = ?`)
      .get(threadId) as { count: number };
    return row.count;
  }

  // ── Platform Mapping CRUD ───────────────────────────────────────────

  /**
   * Create a mapping from a platform thread to a unified thread.
   */
  addPlatformMapping(params: {
    threadId: string;
    channelType: ChannelType;
    platformThreadId: string;
    platformChatId: string;
    now?: number;
  }): PlatformThreadMapping {
    const now = params.now ?? Date.now();

    this.db
      .prepare(
        `INSERT OR REPLACE INTO platform_thread_mappings
         (thread_id, channel_type, platform_thread_id, platform_chat_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        params.threadId,
        params.channelType,
        params.platformThreadId,
        params.platformChatId,
        now,
      );

    return {
      threadId: params.threadId,
      channelType: params.channelType,
      platformThreadId: params.platformThreadId,
      platformChatId: params.platformChatId,
      createdAt: now,
    };
  }

  /**
   * Look up a unified thread by platform thread ID.
   */
  getThreadByPlatformId(
    channelType: ChannelType,
    platformThreadId: string,
    platformChatId: string,
  ): UnifiedThread | null {
    const row = this.db
      .prepare(
        `SELECT thread_id FROM platform_thread_mappings
         WHERE channel_type = ? AND platform_thread_id = ? AND platform_chat_id = ?`,
      )
      .get(channelType, platformThreadId, platformChatId) as { thread_id: string } | undefined;

    if (!row) {
      return null;
    }
    return this.getThread(row.thread_id);
  }

  /**
   * Get all platform mappings for a thread.
   */
  getPlatformMappings(threadId: string): PlatformThreadMapping[] {
    const rows = this.db
      .prepare(`SELECT * FROM platform_thread_mappings WHERE thread_id = ?`)
      .all(threadId) as MappingRow[];
    return rows.map(rowToMapping);
  }

  /**
   * Remove a platform mapping.
   */
  removePlatformMapping(
    channelType: ChannelType,
    platformThreadId: string,
    platformChatId: string,
  ): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM platform_thread_mappings
         WHERE channel_type = ? AND platform_thread_id = ? AND platform_chat_id = ?`,
      )
      .run(channelType, platformThreadId, platformChatId);
    return result.changes > 0;
  }

  // ── Search ────────────────────────────────────────────────────────────

  /**
   * Search threads by various criteria.
   */
  searchThreads(criteria: ThreadSearchCriteria): UnifiedThread[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (criteria.participant) {
      // JSON array search — participants is stored as JSON array
      conditions.push(`participants LIKE ?`);
      params.push(`%"${criteria.participant}"%`);
    }

    if (criteria.topic) {
      conditions.push(`topic LIKE ?`);
      params.push(`%${criteria.topic}%`);
    }

    if (criteria.channelType) {
      conditions.push(`channels LIKE ?`);
      params.push(`%"${criteria.channelType}"%`);
    }

    if (criteria.status) {
      if (Array.isArray(criteria.status)) {
        const placeholders = criteria.status.map(() => "?").join(", ");
        conditions.push(`status IN (${placeholders})`);
        params.push(...criteria.status);
      } else {
        conditions.push(`status = ?`);
        params.push(criteria.status);
      }
    }

    if (criteria.updatedAfter !== undefined) {
      conditions.push(`updated_at > ?`);
      params.push(criteria.updatedAfter);
    }

    if (criteria.updatedBefore !== undefined) {
      conditions.push(`updated_at < ?`);
      params.push(criteria.updatedBefore);
    }

    if (criteria.createdAfter !== undefined) {
      conditions.push(`created_at > ?`);
      params.push(criteria.createdAfter);
    }

    if (criteria.createdBefore !== undefined) {
      conditions.push(`created_at < ?`);
      params.push(criteria.createdBefore);
    }

    let sql = `SELECT * FROM unified_threads`;
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }

    const orderBy = criteria.orderBy === "createdAt" ? "created_at" : "updated_at";
    const order = criteria.order ?? "desc";
    sql += ` ORDER BY ${orderBy} ${order}`;

    const limit = criteria.limit ?? 50;
    const offset = criteria.offset ?? 0;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as ThreadRow[];
    return rows.map(rowToThread);
  }

  /**
   * Get threads that are candidates for lifecycle transitions.
   */
  getThreadsByStatusOlderThan(status: ThreadStatus, olderThan: number): UnifiedThread[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM unified_threads
         WHERE status = ? AND updated_at < ?
         ORDER BY updated_at ASC`,
      )
      .all(status, olderThan) as ThreadRow[];
    return rows.map(rowToThread);
  }

  /**
   * Get all active/open threads for a participant.
   */
  getActiveThreadsForParticipant(participant: string): UnifiedThread[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM unified_threads
         WHERE participants LIKE ? AND status IN ('open', 'active')
         ORDER BY updated_at DESC`,
      )
      .all(`%"${participant}"%`) as ThreadRow[];
    return rows.map(rowToThread);
  }

  // ── Stats ─────────────────────────────────────────────────────────────

  /**
   * Get threading statistics.
   */
  getStats(): {
    totalThreads: number;
    byStatus: Record<ThreadStatus, number>;
    totalMessages: number;
    totalMappings: number;
  } {
    const total = this.db.prepare(`SELECT COUNT(*) as count FROM unified_threads`).get() as {
      count: number;
    };

    const statusRows = this.db
      .prepare(`SELECT status, COUNT(*) as count FROM unified_threads GROUP BY status`)
      .all() as Array<{ status: string; count: number }>;

    const msgCount = this.db.prepare(`SELECT COUNT(*) as count FROM thread_messages`).get() as {
      count: number;
    };

    const mapCount = this.db
      .prepare(`SELECT COUNT(*) as count FROM platform_thread_mappings`)
      .get() as { count: number };

    const byStatus: Record<ThreadStatus, number> = {
      open: 0,
      active: 0,
      stale: 0,
      closed: 0,
      archived: 0,
    };
    for (const row of statusRows) {
      byStatus[row.status as ThreadStatus] = row.count;
    }

    return {
      totalThreads: total.count,
      byStatus,
      totalMessages: msgCount.count,
      totalMappings: mapCount.count,
    };
  }
}
