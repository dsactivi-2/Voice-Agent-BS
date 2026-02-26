import { logger } from '../utils/logger.js';
import { DeepgramASRClient } from './client.js';
import type { DeepgramLanguage } from './client.js';

interface PoolEntry {
  client: DeepgramASRClient;
  language: DeepgramLanguage;
  createdAt: number;
}

/**
 * Connection pool for Deepgram WebSocket streaming connections.
 *
 * Maintains a set of pre-warmed or on-demand ASR client connections,
 * allowing callers to acquire and release connections efficiently
 * without the overhead of reconnecting for every utterance.
 *
 * If the pool is exhausted, a new connection is created immediately
 * (non-blocking) rather than queueing the caller.
 */
export class DeepgramConnectionPool {
  private readonly poolSize: number;
  private readonly apiKey: string;
  private readonly available: PoolEntry[] = [];
  private readonly inUse: Map<DeepgramASRClient, DeepgramLanguage> = new Map();
  private statsTimerId: ReturnType<typeof setInterval> | null = null;
  private readonly maxTotal: number;
  private closed = false;

  constructor(poolSize: number = 5, apiKey: string, maxTotal: number = 20) {
    this.poolSize = poolSize;
    this.apiKey = apiKey;
    this.maxTotal = maxTotal;

    // Log pool stats every 30 seconds
    this.statsTimerId = setInterval(() => {
      this.logStats();
    }, 30_000);
    this.statsTimerId.unref();

    logger.info({ poolSize, maxTotal }, 'DeepgramConnectionPool created');
  }

  /**
   * Acquires a Deepgram ASR client from the pool. If a connection matching
   * the requested language is available, it is returned immediately.
   * Otherwise a new connection is created.
   *
   * @param language - The target transcription language ('bs' or 'sr')
   * @returns A connected DeepgramASRClient ready to receive audio
   */
  async acquire(language: DeepgramLanguage): Promise<DeepgramASRClient> {
    if (this.closed) {
      throw new Error('DeepgramConnectionPool is closed');
    }

    // Try to find an available connection for the requested language
    const entryIndex = this.available.findIndex((entry) => entry.language === language);

    if (entryIndex !== -1) {
      const entry = this.available[entryIndex]!;
      this.available.splice(entryIndex, 1);

      // Verify the connection is still alive
      if (entry.client.isConnected()) {
        this.inUse.set(entry.client, language);
        logger.debug(
          { language, availableCount: this.available.length, inUseCount: this.inUse.size },
          'DeepgramPool: reused existing connection',
        );
        return entry.client;
      }

      // Connection was stale, discard and create a new one
      logger.debug({ language }, 'DeepgramPool: discarding stale connection');
    }

    // Guard: enforce max total connection limit
    if (this.inUse.size >= this.maxTotal) {
      logger.error(
        { inUse: this.inUse.size, maxTotal: this.maxTotal },
        'DeepgramPool: max total connections reached',
      );
      throw new Error(`DeepgramConnectionPool: max total connections (${this.maxTotal}) reached`);
    }

    // No suitable connection found or pool empty -- create a new one
    const client = await this.createConnection(language);
    this.inUse.set(client, language);

    logger.debug(
      { language, availableCount: this.available.length, inUseCount: this.inUse.size },
      'DeepgramPool: created new connection',
    );

    return client;
  }

  /**
   * Releases a Deepgram ASR client back to the pool for reuse.
   * If the pool is already at capacity, the connection is closed instead.
   *
   * @param client - The client to release
   */
  release(client: DeepgramASRClient): void {
    const language = this.inUse.get(client);
    this.inUse.delete(client);

    if (this.closed) {
      void client.close();
      return;
    }

    // If the client is still connected and there's room in the pool, keep it
    if (client.isConnected() && this.available.length < this.poolSize) {
      // Remove all listeners to prevent leaked event handlers from previous usage
      client.removeAllListeners('transcript');
      client.removeAllListeners('error');

      this.available.push({
        client,
        language: language ?? 'bs',
        createdAt: Date.now(),
      });

      logger.debug(
        { availableCount: this.available.length, inUseCount: this.inUse.size },
        'DeepgramPool: connection returned to pool',
      );
    } else {
      // Pool full or connection dead -- close it
      void client.close();

      logger.debug(
        { availableCount: this.available.length, inUseCount: this.inUse.size },
        'DeepgramPool: connection closed (pool full or disconnected)',
      );
    }
  }

  /**
   * Closes all connections in the pool (both available and in-use)
   * and stops the stats logging timer.
   */
  async closeAll(): Promise<void> {
    this.closed = true;

    if (this.statsTimerId !== null) {
      clearInterval(this.statsTimerId);
      this.statsTimerId = null;
    }

    const closePromises: Promise<void>[] = [];

    // Close available connections
    for (const entry of this.available) {
      closePromises.push(entry.client.close());
    }
    this.available.length = 0;

    // Close in-use connections
    for (const [client] of this.inUse) {
      closePromises.push(client.close());
    }
    this.inUse.clear();

    await Promise.all(closePromises);

    logger.info('DeepgramConnectionPool: all connections closed');
  }

  /** Returns the number of available connections in the pool. */
  get availableCount(): number {
    return this.available.length;
  }

  /** Returns the number of connections currently in use. */
  get inUseCount(): number {
    return this.inUse.size;
  }

  /** Returns the total number of connections managed by the pool. */
  get totalCount(): number {
    return this.available.length + this.inUse.size;
  }

  /**
   * Creates a new Deepgram ASR client and establishes the WebSocket connection.
   */
  private async createConnection(language: DeepgramLanguage): Promise<DeepgramASRClient> {
    const client = new DeepgramASRClient(language, this.apiKey);
    await client.connect();
    return client;
  }

  /** Logs current pool statistics. */
  private logStats(): void {
    logger.info(
      {
        available: this.available.length,
        inUse: this.inUse.size,
        total: this.totalCount,
        poolSize: this.poolSize,
        maxTotal: this.maxTotal,
      },
      'DeepgramConnectionPool stats',
    );
  }
}
