import OpenAI from 'openai';
import { config } from '../config.js';
import { logger } from './logger.js';

// Lazy singleton — initialised on first call so unit tests can import
// the module without a real API key (tests override the function via vi.mock).
let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }
  return _client;
}

/**
 * Generates an embedding vector for a single text using text-embedding-3-small.
 * Returns a 1536-dimensional float array.
 *
 * @param text - Plain text to embed (max ~8191 tokens)
 * @throws On API error or empty/null response
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const client = getClient();

  const response = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 32_000), // safety cap (~8k tokens)
    encoding_format: 'float',
  });

  const vector = response.data[0]?.embedding;
  if (!vector || vector.length === 0) {
    throw new Error('OpenAI returned empty embedding');
  }

  return vector;
}

/**
 * Generates embeddings for multiple texts in a single API call.
 * OpenAI supports up to 2048 inputs per request; we batch at 100 to be safe.
 *
 * @param texts - Array of strings to embed
 * @returns Array of 1536-dimensional float arrays, same order as input
 */
export async function batchEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const BATCH_SIZE = 100;
  const results: number[][] = new Array(texts.length);

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map((t) => t.slice(0, 32_000));

    logger.debug({ batchStart: i, batchSize: batch.length }, 'Embedding batch');

    const client = getClient();
    const response = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: batch,
      encoding_format: 'float',
    });

    // OpenAI returns results in order, but double-check with index
    for (const item of response.data) {
      const idx = i + item.index;
      const vec = item.embedding;
      if (!vec || vec.length === 0) {
        throw new Error(`Empty embedding at index ${idx}`);
      }
      results[idx] = vec;
    }
  }

  return results;
}

/**
 * Formats a number[] embedding as a Postgres vector literal: '[1.0,2.0,...]'
 */
export function toPostgresVector(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
