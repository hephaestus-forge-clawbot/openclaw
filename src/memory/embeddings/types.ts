/**
 * Hephie local embedding types.
 *
 * Standalone interfaces for the local/offline embedding pipeline used by the
 * Hephie 4-tier memory system.  These intentionally do NOT depend on the
 * existing `src/memory/embeddings.ts` provider surface so the module can be
 * developed, tested and used independently.
 */

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * A provider that can turn text into dense vector embeddings.
 *
 * Implementations MUST:
 *  - Return L2-normalised vectors (unit length) for cosine similarity.
 *  - Be safe to call concurrently (no shared mutable state across calls).
 */
export interface EmbeddingProvider {
  /** Identifier of the model used for embedding (e.g. "sentence-transformers/all-MiniLM-L6-v2"). */
  readonly modelId: string;

  /** Dimensionality of the output vectors (e.g. 384 for MiniLM-L6-v2). */
  readonly dimensions: number;

  /** Embed a single piece of text.  Returns a float array of length `dimensions`. */
  embed(text: string): Promise<number[]>;

  /**
   * Embed multiple texts.
   *
   * @param texts     The texts to embed.
   * @param batchSize Optional hint: how many texts to process in one forward
   *                  pass.  Implementations are free to ignore this.
   * @returns An array of float arrays, one per input text.
   */
  embedBatch(texts: string[], batchSize?: number): Promise<number[][]>;

  /** Returns `true` if the provider is ready to serve embeddings. */
  isAvailable(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type EmbeddingProviderType = "local" | "ollama";

export interface LocalEmbeddingConfig {
  /** HuggingFace model id.  Default: `"sentence-transformers/all-MiniLM-L6-v2"` */
  model?: string;
  /** Vector dimensionality (must match the model). Default: 384 */
  dimensions?: number;
  /** Max tokens the model accepts.  Texts longer than this are truncated.  Default: 512 */
  maxTokens?: number;
}

export interface OllamaEmbeddingConfig {
  /** Ollama model name.  Default: `"nomic-embed-text"` */
  model?: string;
  /** Ollama server URL.  Default: `"http://127.0.0.1:11434"` */
  baseUrl?: string;
  /** Vector dimensionality (must match the model). Default: 768 */
  dimensions?: number;
}

export interface EmbeddingConfig {
  /** Which provider to use.  Default: `"local"` */
  provider?: EmbeddingProviderType;
  local?: LocalEmbeddingConfig;
  ollama?: OllamaEmbeddingConfig;
}
