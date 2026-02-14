/**
 * Hephie Ollama embedding provider.
 *
 * Delegates to a locally-running Ollama server (`/api/embed` endpoint).
 * This is a secondary provider — when Ollama is not available the factory
 * falls back to the local transformers.js provider automatically.
 */

import type { EmbeddingProvider, OllamaEmbeddingConfig } from "./types.js";
import { normalizeVector, truncateForEmbedding } from "./utils.js";

const DEFAULT_MODEL = "nomic-embed-text";
const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_DIMENSIONS = 768;
const DEFAULT_MAX_TOKENS = 8192; // nomic-embed-text supports up to 8k tokens

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;

  private readonly baseUrl: string;
  private readonly maxTokens: number;

  constructor(config?: OllamaEmbeddingConfig) {
    this.modelId = config?.model ?? DEFAULT_MODEL;
    this.baseUrl = (config?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.dimensions = config?.dimensions ?? DEFAULT_DIMENSIONS;
    this.maxTokens = DEFAULT_MAX_TOKENS;
  }

  // -------------------------------------------------------------------------
  // EmbeddingProvider
  // -------------------------------------------------------------------------

  async embed(text: string): Promise<number[]> {
    const truncated = truncateForEmbedding(text, this.maxTokens);
    const body = JSON.stringify({ model: this.modelId, input: truncated });

    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Ollama embed failed (${res.status}): ${detail}`);
    }

    const json = (await res.json()) as { embeddings: number[][] };
    const vec = json.embeddings?.[0];

    if (!vec || !Array.isArray(vec)) {
      throw new Error("Ollama returned unexpected response shape");
    }

    return normalizeVector(vec);
  }

  async embedBatch(texts: string[], _batchSize?: number): Promise<number[][]> {
    // Ollama's /api/embed supports multiple inputs in one call.
    const truncated = texts.map((t) => truncateForEmbedding(t, this.maxTokens));
    const body = JSON.stringify({ model: this.modelId, input: truncated });

    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Ollama embedBatch failed (${res.status}): ${detail}`);
    }

    const json = (await res.json()) as { embeddings: number[][] };
    const embeddings = json.embeddings;

    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
      throw new Error(
        `Ollama returned ${embeddings?.length ?? 0} embeddings for ${texts.length} inputs`,
      );
    }

    return embeddings.map((vec) => normalizeVector(vec));
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
