/**
 * Progress Store (Hephie Phase 4.1)
 *
 * SQLite-backed persistent storage for sub-agent progress events.
 * Follows the same database patterns as ThreadStore (Phase 3.3)
 * and the memory index schema (Phase 2).
 */

import { randomUUID } from "node:crypto";
import type {
  ProgressEvent,
  ProgressEventType,
  ProgressEventMetadata,
  ProgressMetrics,
  ProgressQueryCriteria,
  AggregateMetrics,
} from "./progress-types.js";
import {
  PROGRESS_EVENT_TYPES,
  createDefaultMetrics,
  createEmptyAggregateMetrics,
} from "./progress-types.js";

// ── Database Interface ──────────────────────────────────────────────────

/**
 * Minimal interface for SQLite database operations.
 * Compatible with node:sqlite DatabaseSync.
 */
export interface ProgressDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

// ── Schema ──────────────────────────────────────────────────────────────

/**
 * Create the progress_events table and its indexes.
 */
export function createProgressSchema(db: ProgressDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS progress_events (
      event_id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      session_key TEXT NOT NULL,
      agent_label TEXT NOT NULL,
      event_type TEXT NOT NULL
        CHECK(event_type IN ('SPAWNED','STARTED','PROGRESS','TOOL_CALL','THINKING','COMPLETED','FAILED')),
      message TEXT NOT NULL DEFAULT '',
      steps_completed INTEGER NOT NULL DEFAULT 0,
      estimated_remaining INTEGER,
      confidence REAL,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      thinking_block_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_pe_session_key ON progress_events(session_key);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pe_event_type ON progress_events(event_type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pe_timestamp ON progress_events(timestamp);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pe_agent_label ON progress_events(agent_label);`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_pe_session_timestamp ON progress_events(session_key, timestamp);`,
  );
}

// ── Row Types ───────────────────────────────────────────────────────────

interface ProgressEventRow {
  event_id: string;
  timestamp: number;
  session_key: string;
  agent_label: string;
  event_type: string;
  message: string;
  steps_completed: number;
  estimated_remaining: number | null;
  confidence: number | null;
  tool_call_count: number;
  thinking_block_count: number;
  metadata: string | null;
}

// ── Converters ──────────────────────────────────────────────────────────

function rowToEvent(row: ProgressEventRow): ProgressEvent {
  const metrics: ProgressMetrics = {
    stepsCompleted: row.steps_completed,
    toolCallCount: row.tool_call_count,
    thinkingBlockCount: row.thinking_block_count,
  };
  if (row.estimated_remaining !== null) {
    metrics.estimatedRemaining = row.estimated_remaining;
  }
  if (row.confidence !== null) {
    metrics.confidence = row.confidence;
  }

  const event: ProgressEvent = {
    eventId: row.event_id,
    timestamp: row.timestamp,
    sessionKey: row.session_key,
    agentLabel: row.agent_label,
    eventType: row.event_type as ProgressEventType,
    message: row.message,
    metrics,
  };

  if (row.metadata) {
    try {
      event.metadata = JSON.parse(row.metadata) as ProgressEventMetadata;
    } catch {
      // Ignore malformed metadata
    }
  }

  return event;
}

// ── Progress Store ──────────────────────────────────────────────────────

/**
 * Persistent store for sub-agent progress events.
 */
export class ProgressStore {
  private readonly db: ProgressDatabase;

  constructor(db: ProgressDatabase) {
    this.db = db;
    createProgressSchema(db);
  }

  // ── Create ──────────────────────────────────────────────────────────

  /**
   * Insert a new progress event.
   */
  insertEvent(params: {
    sessionKey: string;
    agentLabel: string;
    eventType: ProgressEventType;
    message?: string;
    metrics?: Partial<ProgressMetrics>;
    metadata?: ProgressEventMetadata;
    timestamp?: number;
    eventId?: string;
  }): ProgressEvent {
    const eventId = params.eventId ?? randomUUID();
    const timestamp = params.timestamp ?? Date.now();
    const metrics = { ...createDefaultMetrics(), ...params.metrics };
    const message = params.message ?? "";

    this.db
      .prepare(
        `INSERT INTO progress_events
         (event_id, timestamp, session_key, agent_label, event_type, message,
          steps_completed, estimated_remaining, confidence,
          tool_call_count, thinking_block_count, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        timestamp,
        params.sessionKey,
        params.agentLabel,
        params.eventType,
        message,
        metrics.stepsCompleted,
        metrics.estimatedRemaining ?? null,
        metrics.confidence ?? null,
        metrics.toolCallCount,
        metrics.thinkingBlockCount,
        params.metadata ? JSON.stringify(params.metadata) : null,
      );

    return {
      eventId,
      timestamp,
      sessionKey: params.sessionKey,
      agentLabel: params.agentLabel,
      eventType: params.eventType,
      message,
      metrics,
      metadata: params.metadata,
    };
  }

  // ── Read ────────────────────────────────────────────────────────────

  /**
   * Get a single event by ID.
   */
  getEvent(eventId: string): ProgressEvent | null {
    const row = this.db.prepare(`SELECT * FROM progress_events WHERE event_id = ?`).get(eventId) as
      | ProgressEventRow
      | undefined;
    return row ? rowToEvent(row) : null;
  }

  /**
   * Get the latest event for a session.
   */
  getLatestEvent(sessionKey: string): ProgressEvent | null {
    const row = this.db
      .prepare(
        `SELECT * FROM progress_events
         WHERE session_key = ?
         ORDER BY timestamp DESC
         LIMIT 1`,
      )
      .get(sessionKey) as ProgressEventRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  /**
   * Query events with flexible criteria.
   */
  queryEvents(criteria: ProgressQueryCriteria): ProgressEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (criteria.sessionKey) {
      conditions.push(`session_key = ?`);
      params.push(criteria.sessionKey);
    }

    if (criteria.agentLabel) {
      conditions.push(`agent_label LIKE ?`);
      params.push(`%${criteria.agentLabel}%`);
    }

    if (criteria.eventTypes && criteria.eventTypes.length > 0) {
      const placeholders = criteria.eventTypes.map(() => "?").join(", ");
      conditions.push(`event_type IN (${placeholders})`);
      params.push(...criteria.eventTypes);
    }

    if (criteria.since !== undefined) {
      conditions.push(`timestamp >= ?`);
      params.push(criteria.since);
    }

    if (criteria.until !== undefined) {
      conditions.push(`timestamp <= ?`);
      params.push(criteria.until);
    }

    let sql = `SELECT * FROM progress_events`;
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }

    const order = criteria.order ?? "asc";
    sql += ` ORDER BY timestamp ${order}`;

    const limit = criteria.limit ?? 1000;
    const offset = criteria.offset ?? 0;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as ProgressEventRow[];
    return rows.map(rowToEvent);
  }

  /**
   * Get all events for a session, ordered by timestamp.
   */
  getSessionEvents(sessionKey: string): ProgressEvent[] {
    return this.queryEvents({ sessionKey, order: "asc" });
  }

  /**
   * Get all unique session keys that have events.
   */
  getActiveSessions(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT session_key FROM progress_events
         WHERE session_key NOT IN (
           SELECT session_key FROM progress_events
           WHERE event_type IN ('COMPLETED', 'FAILED')
         )`,
      )
      .all() as Array<{ session_key: string }>;
    return rows.map((r) => r.session_key);
  }

  /**
   * Get all unique session keys.
   */
  getAllSessions(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT session_key FROM progress_events ORDER BY session_key`)
      .all() as Array<{ session_key: string }>;
    return rows.map((r) => r.session_key);
  }

  // ── Delete ──────────────────────────────────────────────────────────

  /**
   * Delete all events for a session.
   */
  deleteSessionEvents(sessionKey: string): number {
    const result = this.db
      .prepare(`DELETE FROM progress_events WHERE session_key = ?`)
      .run(sessionKey);
    return result.changes;
  }

  /**
   * Delete events older than a given timestamp.
   */
  deleteEventsOlderThan(timestamp: number): number {
    const result = this.db
      .prepare(`DELETE FROM progress_events WHERE timestamp < ?`)
      .run(timestamp);
    return result.changes;
  }

  /**
   * Delete a specific event by ID.
   */
  deleteEvent(eventId: string): boolean {
    const result = this.db.prepare(`DELETE FROM progress_events WHERE event_id = ?`).run(eventId);
    return result.changes > 0;
  }

  // ── Aggregates ──────────────────────────────────────────────────────

  /**
   * Compute aggregate metrics across all sessions or a specific session.
   */
  getAggregateMetrics(sessionKey?: string): AggregateMetrics {
    const agg = createEmptyAggregateMetrics();

    // Count by event type
    const typeCondition = sessionKey ? `WHERE session_key = ?` : ``;
    const typeParams: unknown[] = sessionKey ? [sessionKey] : [];

    const typeRows = this.db
      .prepare(
        `SELECT event_type, COUNT(*) as count FROM progress_events ${typeCondition} GROUP BY event_type`,
      )
      .all(...typeParams) as Array<{ event_type: string; count: number }>;

    for (const row of typeRows) {
      if (PROGRESS_EVENT_TYPES.includes(row.event_type as ProgressEventType)) {
        agg.eventsByType[row.event_type as ProgressEventType] = row.count;
        agg.totalEvents += row.count;
      }
    }

    // Tool usage
    const toolRows = this.db
      .prepare(
        `SELECT metadata FROM progress_events ${typeCondition.replace("session_key", "session_key")}${sessionKey ? " AND" : " WHERE"} event_type = 'TOOL_CALL' AND metadata IS NOT NULL`,
      )
      .all(...typeParams) as Array<{ metadata: string }>;

    const toolSet = new Set<string>();
    for (const row of toolRows) {
      try {
        const meta = JSON.parse(row.metadata) as ProgressEventMetadata;
        if (meta.toolName) {
          toolSet.add(meta.toolName);
        }
      } catch {
        // Ignore malformed metadata
      }
    }
    agg.uniqueTools = [...toolSet].toSorted();

    // Total tool calls from latest metrics per session
    const toolCountRows = this.db
      .prepare(
        `SELECT SUM(tool_call_count) as total FROM (
           SELECT tool_call_count FROM progress_events ${typeCondition}
           ORDER BY timestamp DESC
         )`,
      )
      .all(...typeParams) as Array<{ total: number | null }>;

    agg.totalToolCalls = toolCountRows[0]?.total ?? 0;

    // Session counts
    if (!sessionKey) {
      const allSessionsRows = this.db
        .prepare(`SELECT DISTINCT session_key FROM progress_events`)
        .all() as Array<{ session_key: string }>;
      const totalSessions = allSessionsRows.length;

      const completedRows = this.db
        .prepare(`SELECT DISTINCT session_key FROM progress_events WHERE event_type = 'COMPLETED'`)
        .all() as Array<{ session_key: string }>;
      agg.completedSessions = completedRows.length;

      const failedRows = this.db
        .prepare(`SELECT DISTINCT session_key FROM progress_events WHERE event_type = 'FAILED'`)
        .all() as Array<{ session_key: string }>;
      agg.failedSessions = failedRows.length;

      agg.activeSessions = totalSessions - agg.completedSessions - agg.failedSessions;
      agg.completionPercent =
        totalSessions > 0
          ? Math.round(((agg.completedSessions + agg.failedSessions) / totalSessions) * 100)
          : 0;
    } else {
      // For single session
      const hasTerminal = agg.eventsByType.COMPLETED > 0 || agg.eventsByType.FAILED > 0;
      if (hasTerminal) {
        agg.completedSessions = agg.eventsByType.COMPLETED > 0 ? 1 : 0;
        agg.failedSessions = agg.eventsByType.FAILED > 0 ? 1 : 0;
        agg.completionPercent = 100;
      } else {
        agg.activeSessions = 1;
        agg.completionPercent = 0;
      }
    }

    // Time elapsed
    const timeCondition = sessionKey ? `WHERE session_key = ?` : ``;
    const timeParams: unknown[] = sessionKey ? [sessionKey] : [];
    const timeRow = this.db
      .prepare(
        `SELECT MIN(timestamp) as min_ts, MAX(timestamp) as max_ts FROM progress_events ${timeCondition}`,
      )
      .get(...timeParams) as { min_ts: number | null; max_ts: number | null } | undefined;
    if (timeRow?.min_ts !== null && timeRow?.max_ts !== null && timeRow) {
      agg.elapsedMs = timeRow.max_ts - timeRow.min_ts;
    }

    return agg;
  }

  /**
   * Get event count.
   */
  getEventCount(sessionKey?: string): number {
    if (sessionKey) {
      const row = this.db
        .prepare(`SELECT COUNT(*) as count FROM progress_events WHERE session_key = ?`)
        .get(sessionKey) as { count: number };
      return row.count;
    }
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM progress_events`).get() as {
      count: number;
    };
    return row.count;
  }
}
