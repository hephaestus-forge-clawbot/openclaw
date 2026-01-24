import { describe, expect, it } from "vitest";

import type { StreamFn } from "@mariozechner/pi-agent-core";

import type { ClawdbotConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { createAnthropicPayloadLogger } from "./anthropic-payload-log.js";

describe("createAnthropicPayloadLogger", () => {
  it("returns null when diagnostics payload logging is disabled", () => {
    const logger = createAnthropicPayloadLogger({
      cfg: {} as ClawdbotConfig,
      env: {},
      modelApi: "anthropic-messages",
    });

    expect(logger).toBeNull();
  });

  it("returns null when model api is not anthropic", () => {
    const logger = createAnthropicPayloadLogger({
      cfg: {
        diagnostics: {
          anthropicPayloadLog: {
            enabled: true,
          },
        },
      },
      env: {},
      modelApi: "openai",
      writer: {
        filePath: "memory",
        write: () => undefined,
      },
    });

    expect(logger).toBeNull();
  });

  it("honors diagnostics config and expands file paths", () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      cfg: {
        diagnostics: {
          anthropicPayloadLog: {
            enabled: true,
            filePath: "~/.clawdbot/logs/anthropic-payload.jsonl",
          },
        },
      },
      env: {},
      modelApi: "anthropic-messages",
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    expect(logger).not.toBeNull();
    expect(logger?.filePath).toBe(resolveUserPath("~/.clawdbot/logs/anthropic-payload.jsonl"));

    logger?.recordUsage([
      {
        role: "assistant",
        usage: {
          input: 12,
        },
      } as unknown as {
        role: string;
        usage: { input: number };
      },
    ]);

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.stage).toBe("usage");
    expect(event.usage).toEqual({ input: 12 });
  });

  it("records request payloads and forwards onPayload", async () => {
    const lines: string[] = [];
    let forwarded: unknown;
    const logger = createAnthropicPayloadLogger({
      cfg: {
        diagnostics: {
          anthropicPayloadLog: {
            enabled: true,
          },
        },
      },
      env: {},
      modelApi: "anthropic-messages",
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    const streamFn = ((_, __, options) => {
      options?.onPayload?.({ hello: "world" });
      return Promise.resolve(undefined);
    }) as StreamFn;

    const wrapped = logger?.wrapStreamFn(streamFn);
    await wrapped?.(
      { api: "anthropic-messages" } as unknown as { api: string },
      {},
      {
        onPayload: (payload) => {
          forwarded = payload;
        },
      },
    );

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.stage).toBe("request");
    expect(event.payload).toEqual({ hello: "world" });
    expect(event.payloadDigest).toBeTruthy();
    expect(forwarded).toEqual({ hello: "world" });
  });

  it("records errors when usage is missing", () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      cfg: {
        diagnostics: {
          anthropicPayloadLog: {
            enabled: true,
          },
        },
      },
      env: {},
      modelApi: "anthropic-messages",
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    logger?.recordUsage([], new Error("boom"));

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.stage).toBe("usage");
    expect(event.error).toContain("boom");
  });
});
