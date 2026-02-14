/**
 * Hephie local embedding pipeline — public API.
 *
 * Usage:
 * ```ts
 * import { createLocalEmbeddingProvider, cosineSimilarity } from "./memory/embeddings/index.js";
 *
 * const provider = await createLocalEmbeddingProvider();
 * const vec = await provider.embed("hello world");        // number[384]
 * const sim = cosineSimilarity(vec, vec);                  // ~1.0
 * ```
 */

export type {
  EmbeddingConfig,
  EmbeddingProvider,
  EmbeddingProviderType,
  LocalEmbeddingConfig,
  OllamaEmbeddingConfig,
} from "./types.js";

export { LocalEmbeddingProvider } from "./local-provider.js";
export { OllamaEmbeddingProvider } from "./ollama-provider.js";
export { cosineSimilarity, normalizeVector, truncateForEmbedding } from "./utils.js";

import type { EmbeddingConfig, EmbeddingProvider } from "./types.js";
import { LocalEmbeddingProvider } from "./local-provider.js";
import { OllamaEmbeddingProvider } from "./ollama-provider.js";

/**
 * Factory: create the best available embedding provider.
 *
 * - If `config.provider === "ollama"` and Ollama is reachable → use Ollama.
 * - Otherwise → use the local transformers.js provider (always available,
 *   no network / GPU required).
 */
export async function createEmbeddingProvider(
  config?: EmbeddingConfig,
): Promise<EmbeddingProvider> {
  const providerType = config?.provider ?? "local";

  if (providerType === "ollama") {
    const ollama = new OllamaEmbeddingProvider(config?.ollama);
    if (await ollama.isAvailable()) {
      return ollama;
    }
    console.log(
      "[hephie:embeddings] Ollama unavailable — falling back to local transformers.js provider",
    );
  }

  return new LocalEmbeddingProvider(config?.local);
}
