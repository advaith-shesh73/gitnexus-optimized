/**
 * HTTP Embedding Client
 *
 * Shared fetch+retry logic for OpenAI-compatible /v1/embeddings endpoints.
 * Imported by both the core embedder (batch) and MCP embedder (query).
 */

const HTTP_TIMEOUT_MS = 30_000;
const HTTP_MAX_RETRIES = 2;
const HTTP_RETRY_BACKOFF_MS = 1_000;
const HTTP_BATCH_SIZE = 64;
const DEFAULT_DIMS = 384;
const DEFAULT_CONCURRENCY = 10;

interface HttpConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeys: string[];
  dimensions?: number;
  concurrency: number;
}

/**
 * Build config from the current process.env snapshot.
 * Returns null when GITNEXUS_EMBEDDING_URL + GITNEXUS_EMBEDDING_MODEL are unset.
 *
 * Multi-key support: GITNEXUS_EMBEDDING_API_KEYS (comma-separated) takes precedence
 * over GITNEXUS_EMBEDDING_API_KEY. Requests are distributed round-robin across keys.
 *
 * Concurrency: GITNEXUS_EMBEDDING_CONCURRENCY controls max parallel HTTP requests
 * (default 10). Set to 100-150 for high-throughput endpoints.
 */
const readConfig = (): HttpConfig | null => {
  const baseUrl = process.env.GITNEXUS_EMBEDDING_URL;
  const model = process.env.GITNEXUS_EMBEDDING_MODEL;
  if (!baseUrl || !model) return null;

  const rawDims = process.env.GITNEXUS_EMBEDDING_DIMS;
  let dimensions: number | undefined;
  if (rawDims !== undefined) {
    const parsed = parseInt(rawDims, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new Error(
        `GITNEXUS_EMBEDDING_DIMS must be a positive integer, got "${rawDims}"`,
      );
    }
    dimensions = parsed;
  }

  const singleKey = process.env.GITNEXUS_EMBEDDING_API_KEY ?? 'unused';
  const multiKeys = process.env.GITNEXUS_EMBEDDING_API_KEYS;
  const apiKeys = multiKeys
    ? multiKeys.split(',').map(k => k.trim()).filter(Boolean)
    : [singleKey];

  const rawConcurrency = process.env.GITNEXUS_EMBEDDING_CONCURRENCY;
  let concurrency = DEFAULT_CONCURRENCY;
  if (rawConcurrency) {
    const parsed = parseInt(rawConcurrency, 10);
    if (!Number.isNaN(parsed) && parsed > 0) concurrency = parsed;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKey: apiKeys[0],
    apiKeys,
    dimensions,
    concurrency,
  };
};

/**
 * Check whether HTTP embedding mode is active (env vars are set).
 */
export const isHttpMode = (): boolean => readConfig() !== null;

/**
 * Return the configured embedding dimensions for HTTP mode, or undefined
 * if HTTP mode is not active or no explicit dimensions are set.
 */
export const getHttpDimensions = (): number | undefined => readConfig()?.dimensions;

/**
 * Return a safe representation of a URL for error messages.
 * Strips query string (may contain tokens) and userinfo.
 */
const safeUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<invalid-url>';
  }
};

interface EmbeddingItem {
  embedding: number[];
}

/**
 * Send a single batch of texts to the embedding endpoint with retry.
 *
 * @param url - Full endpoint URL (e.g. https://host/v1/embeddings)
 * @param batch - Texts to embed
 * @param model - Model name for the request body
 * @param apiKey - Bearer token (only used in Authorization header)
 * @param batchIndex - Logical batch number (for error context)
 * @param attempt - Current retry attempt (internal)
 */
const httpEmbedBatch = async (
  url: string,
  batch: string[],
  model: string,
  apiKey: string,
  batchIndex = 0,
  attempt = 0,
): Promise<EmbeddingItem[]> => {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input: batch, model }),
    });
  } catch (err) {
    // Timeouts should not be retried — the server is unresponsive.
    // AbortSignal.timeout() throws DOMException with name 'TimeoutError'.
    const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
    if (isTimeout) {
      throw new Error(
        `Embedding request timed out after ${HTTP_TIMEOUT_MS}ms (${safeUrl(url)}, batch ${batchIndex})`,
      );
    }
    // DNS, connection errors — retry with backoff
    if (attempt < HTTP_MAX_RETRIES) {
      const delay = HTTP_RETRY_BACKOFF_MS * (attempt + 1);
      await new Promise(r => setTimeout(r, delay));
      return httpEmbedBatch(url, batch, model, apiKey, batchIndex, attempt + 1);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Embedding request failed (${safeUrl(url)}, batch ${batchIndex}): ${reason}`,
    );
  }

  if (!resp.ok) {
    const status = resp.status;
    if ((status === 429 || status >= 500) && attempt < HTTP_MAX_RETRIES) {
      const delay = HTTP_RETRY_BACKOFF_MS * (attempt + 1);
      await new Promise(r => setTimeout(r, delay));
      return httpEmbedBatch(url, batch, model, apiKey, batchIndex, attempt + 1);
    }
    throw new Error(
      `Embedding endpoint returned ${status} (${safeUrl(url)}, batch ${batchIndex})`,
    );
  }

  const data = (await resp.json()) as { data: EmbeddingItem[] };
  return data.data;
};

/**
 * Concurrency-limited parallel executor.
 * Runs up to `limit` promises simultaneously, returning results in input order.
 */
const parallelMap = async <T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
};

/**
 * Embed texts via the HTTP backend, splitting into batches and running
 * them in parallel across multiple API keys.
 *
 * Concurrency and key rotation are controlled by:
 *   GITNEXUS_EMBEDDING_CONCURRENCY  (default 10)
 *   GITNEXUS_EMBEDDING_API_KEYS     (comma-separated, round-robin)
 *
 * @param texts - Array of texts to embed
 * @returns Array of Float32Array embedding vectors
 */
export const httpEmbed = async (texts: string[]): Promise<Float32Array[]> => {
  if (texts.length === 0) return [];

  const config = readConfig();
  if (!config) throw new Error('HTTP embedding not configured');

  const url = `${config.baseUrl}/embeddings`;

  // Split texts into batches
  const batches: { texts: string[]; batchIndex: number }[] = [];
  for (let i = 0; i < texts.length; i += HTTP_BATCH_SIZE) {
    batches.push({
      texts: texts.slice(i, i + HTTP_BATCH_SIZE),
      batchIndex: Math.floor(i / HTTP_BATCH_SIZE),
    });
  }

  const expected = config.dimensions ?? DEFAULT_DIMS;
  let keyCounter = 0;

  const batchResults = await parallelMap(
    batches,
    async (batch) => {
      // Round-robin key selection (atomic enough for our purposes)
      const keyIndex = keyCounter++ % config.apiKeys.length;
      const apiKey = config.apiKeys[keyIndex];

      const items = await httpEmbedBatch(url, batch.texts, config.model, apiKey, batch.batchIndex);

      if (items.length !== batch.texts.length) {
        throw new Error(
          `Embedding endpoint returned ${items.length} vectors for ${batch.texts.length} texts ` +
          `(${safeUrl(url)}, batch ${batch.batchIndex})`,
        );
      }

      const vectors: Float32Array[] = [];
      for (const item of items) {
        const vec = new Float32Array(item.embedding);
        if (vec.length !== expected) {
          const hint = config.dimensions
            ? 'Update GITNEXUS_EMBEDDING_DIMS to match your model output.'
            : `Set GITNEXUS_EMBEDDING_DIMS=${vec.length} to match your model output.`;
          throw new Error(
            `Embedding dimension mismatch: endpoint returned ${vec.length}d vector, ` +
            `but expected ${expected}d. ${hint}`,
          );
        }
        vectors.push(vec);
      }

      return vectors;
    },
    config.concurrency,
  );

  // Flatten batch results back into a single ordered array
  const allVectors: Float32Array[] = [];
  for (const batchVecs of batchResults) {
    for (const vec of batchVecs) {
      allVectors.push(vec);
    }
  }

  return allVectors;
};

/**
 * Embed a single query text via the HTTP backend.
 * Convenience for MCP search where only one vector is needed.
 *
 * @param text - Query text to embed
 * @returns Embedding vector as number array
 */
export const httpEmbedQuery = async (text: string): Promise<number[]> => {
  const config = readConfig();
  if (!config) throw new Error('HTTP embedding not configured');

  const url = `${config.baseUrl}/embeddings`;
  const items = await httpEmbedBatch(url, [text], config.model, config.apiKey);
  if (!items.length) {
    throw new Error(`Embedding endpoint returned empty response (${safeUrl(url)})`);
  }

  const embedding = items[0].embedding;
  // Same dimension checks as httpEmbed — catch mismatches before they
  // reach the Kuzu FLOAT[N] cast in search queries.
  const expected = config.dimensions ?? DEFAULT_DIMS;
  if (embedding.length !== expected) {
    const hint = config.dimensions
      ? 'Update GITNEXUS_EMBEDDING_DIMS to match your model output.'
      : `Set GITNEXUS_EMBEDDING_DIMS=${embedding.length} to match your model output.`;
    throw new Error(
      `Embedding dimension mismatch: endpoint returned ${embedding.length}d vector, ` +
      `but expected ${expected}d. ${hint}`,
    );
  }
  return embedding;
};
