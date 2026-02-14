/**
 * Hephie local embedding provider — runs entirely on-device via
 * `@huggingface/transformers` (transformers.js / ONNX Runtime).
 *
 * No GPU required.  Works on macOS ARM64 (Apple Silicon) out of the box.
 *
 * The model is lazy-loaded on first `embed()` call and cached in memory for
 * the lifetime of the process.  First call will download the ONNX model files
 * from HuggingFace Hub (~80 MB for MiniLM-L6-v2) which may take a moment.
 */

import type { EmbeddingProvider, LocalEmbeddingConfig } from "./types.js";
import { normalizeVector, truncateForEmbedding } from "./utils.js";

const DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2";
const DEFAULT_DIMENSIONS = 384;
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_BATCH_SIZE = 32;

/**
 * Opaque handle for the transformers.js feature-extraction pipeline.
 * We use a minimal structural type rather than importing the concrete class
 * (which would pull the entire bundle at import time).
 */
interface FeatureExtractionPipeline {
  (texts: string | string[], options?: Record<string, unknown>): Promise<{ data: Float32Array }>;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;

  private readonly maxTokens: number;
  private pipeline: FeatureExtractionPipeline | null = null;
  private loadingPromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(config?: LocalEmbeddingConfig) {
    this.modelId = config?.model ?? DEFAULT_MODEL;
    this.dimensions = config?.dimensions ?? DEFAULT_DIMENSIONS;
    this.maxTokens = config?.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  // -------------------------------------------------------------------------
  // EmbeddingProvider
  // -------------------------------------------------------------------------

  async embed(text: string): Promise<number[]> {
    const pipe = await this.ensurePipeline();
    const truncated = truncateForEmbedding(text, this.maxTokens);

    const output = await pipe(truncated, { pooling: "mean", normalize: true });

    // output is a Tensor — convert to plain array and ensure it's normalised.
    const flat: number[] = Array.from(output.data);

    // The pipeline may return multiple sequences stacked.  We only sent one
    // text so take the first `dimensions` values.
    const vec = flat.slice(0, this.dimensions);
    return normalizeVector(vec);
  }

  async embedBatch(texts: string[], batchSize?: number): Promise<number[][]> {
    const bs = batchSize ?? DEFAULT_BATCH_SIZE;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += bs) {
      const batch = texts.slice(i, i + bs);
      const pipe = await this.ensurePipeline();

      const truncated = batch.map((t) => truncateForEmbedding(t, this.maxTokens));
      const output = await pipe(truncated, { pooling: "mean", normalize: true });

      const data: Float32Array = output.data;
      const dims = this.dimensions;

      for (let j = 0; j < batch.length; j++) {
        const vec = Array.from(data.slice(j * dims, (j + 1) * dims));
        results.push(normalizeVector(vec));
      }
    }

    return results;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.ensurePipeline();
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async ensurePipeline(): Promise<FeatureExtractionPipeline> {
    if (this.pipeline) {
      return this.pipeline;
    }

    // Avoid multiple concurrent downloads: reuse the same loading promise.
    if (!this.loadingPromise) {
      this.loadingPromise = this.loadPipeline();
    }

    try {
      this.pipeline = await this.loadingPromise;
      return this.pipeline;
    } catch (err) {
      // Reset so a subsequent call can retry.
      this.loadingPromise = null;
      throw err;
    }
  }

  private async loadPipeline(): Promise<FeatureExtractionPipeline> {
    console.log(
      `[hephie:embeddings] Loading local model "${this.modelId}" — first call may download model files…`,
    );
    const start = Date.now();

    // Dynamic import so the (large) transformers.js bundle is only loaded when
    // local embeddings are actually used.
    const { pipeline, env } = await import("@huggingface/transformers");

    // Silence remote-model warnings in Node.js.
    env.allowRemoteModels = true;

    const pipe = await pipeline("feature-extraction", this.modelId, {
      dtype: "fp32",
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[hephie:embeddings] Model loaded in ${elapsed}s`);

    return pipe;
  }
}
