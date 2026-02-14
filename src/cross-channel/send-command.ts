/**
 * Cross-Channel Send CLI Command (Hephie Phase 3.2)
 *
 * Implements `hephie send` CLI command for cross-channel messaging.
 *
 * Usage:
 *   hephie send --channel telegram --to <chatId> --message "Hello!"
 *   hephie send --broadcast --message "Hello all channels!"
 *   hephie send --channel slack --to #general --message "Update"
 *   hephie send --queue-status
 *   hephie send --retry-dead
 */

import type { CrossChannelSender, BroadcastResult, SendResult } from "./cross-channel-sender.js";
import type { MessageQueue, QueueStats } from "./message-queue.js";
import type { ChannelType } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface SendCommandArgs {
  /** Target channel (e.g., "telegram", "slack"). */
  channel?: string;

  /** Destination (chat ID, user ID, channel name). */
  to?: string;

  /** The message to send. */
  message?: string;

  /** Send to all configured broadcast targets. */
  broadcast?: boolean;

  /** Account ID for multi-account channels. */
  accountId?: string;

  /** Thread ID for threaded conversations. */
  threadId?: string;

  /** Queue the message for retry on failure. */
  queue?: boolean;

  /** Show queue status. */
  queueStatus?: boolean;

  /** Process the retry queue now. */
  processQueue?: boolean;

  /** Retry all dead letter messages. */
  retryDead?: boolean;

  /** Show dead letter queue. */
  showDead?: boolean;

  /** Clear the entire queue. */
  clearQueue?: boolean;
}

export interface SendCommandResult {
  /** Whether the command succeeded. */
  success: boolean;

  /** Human-readable output message. */
  output: string;

  /** The send result (for single sends). */
  sendResult?: SendResult;

  /** The broadcast result (for broadcasts). */
  broadcastResult?: BroadcastResult;

  /** Queue stats (for queue-status command). */
  queueStats?: QueueStats;
}

// ── Command Parser ────────────────────────────────────────────────────────

/**
 * Parse CLI arguments into SendCommandArgs.
 */
export function parseSendArgs(argv: string[]): SendCommandArgs {
  const args: SendCommandArgs = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case "--channel":
      case "-c":
        args.channel = argv[++i];
        break;
      case "--to":
      case "-t":
        args.to = argv[++i];
        break;
      case "--message":
      case "-m":
        args.message = argv[++i];
        break;
      case "--broadcast":
      case "-b":
        args.broadcast = true;
        break;
      case "--account-id":
        args.accountId = argv[++i];
        break;
      case "--thread-id":
        args.threadId = argv[++i];
        break;
      case "--queue":
      case "-q":
        args.queue = true;
        break;
      case "--queue-status":
        args.queueStatus = true;
        break;
      case "--process-queue":
        args.processQueue = true;
        break;
      case "--retry-dead":
        args.retryDead = true;
        break;
      case "--show-dead":
        args.showDead = true;
        break;
      case "--clear-queue":
        args.clearQueue = true;
        break;
      default:
        // If we have no message yet and this doesn't look like a flag, treat as message
        if (!arg.startsWith("-") && !args.message) {
          args.message = arg;
        }
        break;
    }
  }

  return args;
}

// ── Command Validation ────────────────────────────────────────────────────

/**
 * Validate send command arguments.
 */
export function validateSendArgs(args: SendCommandArgs): string | null {
  // Queue management commands don't need message/channel
  if (args.queueStatus || args.processQueue || args.retryDead || args.showDead || args.clearQueue) {
    return null;
  }

  if (!args.message) {
    return "Missing required argument: --message";
  }

  if (args.broadcast) {
    // Broadcast doesn't need --channel or --to
    return null;
  }

  if (!args.channel) {
    return "Missing required argument: --channel (or use --broadcast)";
  }

  if (!args.to) {
    return "Missing required argument: --to";
  }

  return null;
}

// ── Command Execution ─────────────────────────────────────────────────────

/**
 * Execute the send command.
 */
export async function executeSendCommand(
  args: SendCommandArgs,
  sender: CrossChannelSender,
  queue?: MessageQueue,
): Promise<SendCommandResult> {
  // ── Queue status ────────────────────────────────────────────────────────
  if (args.queueStatus) {
    if (!queue) {
      return { success: false, output: "Message queue not configured" };
    }
    const stats = queue.getStats();
    return {
      success: true,
      output: formatQueueStats(stats),
      queueStats: stats,
    };
  }

  // ── Process queue ───────────────────────────────────────────────────────
  if (args.processQueue) {
    if (!queue) {
      return { success: false, output: "Message queue not configured" };
    }
    const delivered = await sender.processQueue();
    return {
      success: true,
      output: `Processed queue: ${delivered} message(s) delivered`,
    };
  }

  // ── Show dead letters ───────────────────────────────────────────────────
  if (args.showDead) {
    if (!queue) {
      return { success: false, output: "Message queue not configured" };
    }
    const dead = queue.getDeadLetters();
    if (dead.length === 0) {
      return { success: true, output: "Dead letter queue is empty" };
    }
    const lines = dead.map(
      (msg) =>
        `  [${msg.id}] ${msg.channel} → ${msg.to}: "${msg.message.slice(0, 50)}${msg.message.length > 50 ? "..." : ""}" (${msg.attempts} attempts, error: ${msg.lastError ?? "unknown"})`,
    );
    return {
      success: true,
      output: `Dead letter queue (${dead.length} messages):\n${lines.join("\n")}`,
    };
  }

  // ── Retry dead letters ──────────────────────────────────────────────────
  if (args.retryDead) {
    if (!queue) {
      return { success: false, output: "Message queue not configured" };
    }
    const dead = queue.getDeadLetters();
    let retried = 0;
    for (const msg of dead) {
      await queue.retryDeadLetter(msg.id);
      retried++;
    }
    return {
      success: true,
      output: `Retried ${retried} dead letter message(s)`,
    };
  }

  // ── Clear queue ─────────────────────────────────────────────────────────
  if (args.clearQueue) {
    if (!queue) {
      return { success: false, output: "Message queue not configured" };
    }
    await queue.clear();
    return { success: true, output: "Queue cleared" };
  }

  // ── Validate for send/broadcast ─────────────────────────────────────────
  const validationError = validateSendArgs(args);
  if (validationError) {
    return { success: false, output: validationError };
  }

  // ── Broadcast ───────────────────────────────────────────────────────────
  if (args.broadcast) {
    const broadcastResult = await sender.broadcast({
      message: args.message!,
      queueOnFailure: args.queue,
    });

    const output = formatBroadcastResult(broadcastResult);
    return {
      success: broadcastResult.failureCount === 0,
      output,
      broadcastResult,
    };
  }

  // ── Single send ─────────────────────────────────────────────────────────
  const sendResult = await sender.send({
    channel: args.channel! as ChannelType,
    to: args.to!,
    message: args.message!,
    accountId: args.accountId,
    threadId: args.threadId,
    queueOnFailure: args.queue,
  });

  const output = sendResult.success
    ? `✓ Sent to ${args.channel}:${args.to}${sendResult.messageId ? ` (id: ${sendResult.messageId})` : ""}`
    : `✗ Failed to send to ${args.channel}:${args.to}: ${sendResult.error}${args.queue ? " (queued for retry)" : ""}`;

  return { success: sendResult.success, output, sendResult };
}

// ── Formatters ────────────────────────────────────────────────────────────

function formatQueueStats(stats: QueueStats): string {
  const lines = [
    `Message Queue Status:`,
    `  Pending: ${stats.pending}`,
    `  Dead letters: ${stats.dead}`,
    `  Total: ${stats.total}`,
  ];
  if (stats.oldestMessageAt) {
    const age = Date.now() - stats.oldestMessageAt;
    const ageStr =
      age < 60_000
        ? `${Math.floor(age / 1000)}s`
        : age < 3_600_000
          ? `${Math.floor(age / 60_000)}m`
          : `${Math.floor(age / 3_600_000)}h`;
    lines.push(`  Oldest message: ${ageStr} ago`);
  }
  return lines.join("\n");
}

function formatBroadcastResult(result: BroadcastResult): string {
  const lines = [`Broadcast: ${result.successCount}/${result.results.length} succeeded`];
  for (const r of result.results) {
    const status = r.success ? "✓" : "✗";
    const detail = r.success ? (r.messageId ? ` (id: ${r.messageId})` : "") : `: ${r.error}`;
    lines.push(`  ${status} ${r.channel} → ${r.to}${detail}`);
  }
  return lines.join("\n");
}

// ── Help Text ─────────────────────────────────────────────────────────────

export const SEND_COMMAND_HELP = `
hephie send — Cross-channel messaging

Usage:
  hephie send --channel <channel> --to <destination> --message "text"
  hephie send --broadcast --message "text"

Options:
  -c, --channel <type>    Target channel (telegram, slack, discord, whatsapp, etc.)
  -t, --to <dest>         Destination (chat ID, user ID, channel name)
  -m, --message <text>    Message text to send
  -b, --broadcast         Send to all configured broadcast targets
  --account-id <id>       Account ID for multi-account channels
  --thread-id <id>        Thread ID for threaded conversations
  -q, --queue             Queue for retry on failure
  --queue-status          Show message queue status
  --process-queue         Process pending retry queue
  --show-dead             Show dead letter queue
  --retry-dead            Retry all dead letter messages
  --clear-queue           Clear the entire message queue

Examples:
  hephie send -c telegram -t 12345 -m "Hello from CLI!"
  hephie send --broadcast -m "System update notification"
  hephie send -c slack -t "#general" -m "Meeting in 5 minutes" --queue
  hephie send --queue-status
`.trim();
