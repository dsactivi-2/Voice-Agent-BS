import { logger } from '../utils/logger.js';
import { DeepgramASRClient } from './client.js';
import type { DeepgramLanguage } from './client.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PoolEntry {
  client: DeepgramASRClient;
  language: DeepgramLanguage;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// DeepgramConnectionPool
// ---------------------------------------------------------------------------

/**
 * Connection pool for Deepgram WebSocket streaming connections.
 *
 * Maintains a set of pre-warmed or on-demand ASR client connections,
 * allowing callers to acquire and release connections efficiently
 * without the overhead of reconnecting for every utterance.
 *
 * If the pool is exhausted, a new connection is created immediately
 * (non-blocking) rather than queueing the caller.
 *
 * Usage:
 *   const pool = new DeepgramConnectionPool(3, apiKey);
 *   await pool.warmUp('bs', 2); // pre-warm 2 Bosnian connections at startup
 *   const client = await pool.acquire('bs'); // grab a ready connection
 *   client.sendAudio(pcmBuffer);            // stream audio to Deepgram
 *   pool.release(client);                   // return to pool when call ends
 */
export class DeepgramConnectionPool {
  private readonly poolSize: number;
  private readonly apiKey: string;
  private readonly available: PoolEntry[] = [];
  private readonly inUse = new Map<DeepgramASRClient, DeepgramLanguage>();
  private statsTimerId: ReturnType<typeof setInterval> | null = null;
  private readonly maxTotal: number;
  private closed = false;

  constructor(poolSize = 5, apiKey: string, maxTotal = 20) {
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

  // ─────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────

  /**
   * Acquires a Deepgram ASR client from the pool. If a connection matching
   * the requested language is available, it is returned immediately.
   * Otherwise a new connection is created.
   *
   * @param language - The target transcription language ('bs' or 'sr')
   * @returns A connected DeepgramASRClient ready to receive audio
   * @throws When the pool is closed or max total connections is reached
   */
  async acquire(language: DeepgramLanguage): Promise<DeepgramASRClient> {
    if (this.closed) {
      throw new Error('DeepgramConnectionPool is closed');
    }

    // Try to find an available connection for the requested language
    const entryIndex = this.available.findIndex((entry) => entry.language === language);

    if (entryIndex !== -1) {
      const entry = this.available[entryIndex];
      if (!entry) throw new Error('Invariant: findIndex returned out-of-bounds index');
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

      // Connection was stale, discard and create a new one below
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

    // No suitable connection available — create a new one on-demand
    const client = await this.createConnection(language);
    this.inUse.set(client, language);
    logger.debug(
      { language, availableCount: this.available.length, inUseCount: this.inUse.size },
      'DeepgramPool: created new connection on-demand',
    );
    return client;
  }

  /**
   * Releases a Deepgram ASR client back to the pool for reuse.
   * Strips all event listeners before returning so the next caller
   * starts with a clean listener state.
   * If the pool is already at capacity or the client is disconnected,
   * the connection is closed and discarded.
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
      // Strip all application-level listeners to prevent handler leaks between calls.
      // The internal SDK listeners (error, close, reconnect) are managed by the client.
      client.removeAllListeners('transcript');
      client.removeAllListeners('error');
      client.removeAllListeners('reconnected');

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
      // Pool full or connection dead — close it
      void client.close();
      logger.debug(
        { availableCount: this.available.length, inUseCount: this.inUse.size },
        'DeepgramPool: connection closed (pool full or disconnected)',
      );
    }
  }

  /**
   * Pre-warms the pool by establishing `count` connections for the given language.
   * This should be called at server startup so the first calls don't pay
   * the Deepgram WebSocket handshake cost (~5s on a cold start).
   *
   * Errors are logged but do not reject — the pool remains usable even if
   * warm-up partially fails.
   *
   * @param language - The language to pre-warm connections for
   * @param count    - Number of connections to create
   */
  async warmUp(language: DeepgramLanguage, count: number): Promise<void> {
    const promises = Array.from({ length: count }, async () => {
      try {
        const client = await this.createConnection(language);
        if (!this.closed && this.available.length < this.poolSize) {
          this.available.push({ client, language, createdAt: Date.now() });
        } else {
          void client.close();
        }
      } catch (err: unknown) {
        logger.warn({ err, language }, 'DeepgramPool: warm-up connection failed');
      }
    });

    await Promise.allSettled(promises);
    logger.info(
      { language, requested: count, availableCount: this.available.length },
      'DeepgramPool: warm-up complete',
    );
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

    for (const entry of this.available) {
      closePromises.push(entry.client.close());
    }
    this.available.length = 0;

    for (const [client] of this.inUse) {
      closePromises.push(client.close());
    }
    this.inUse.clear();

    await Promise.all(closePromises);
    logger.info('DeepgramConnectionPool: all connections closed');
  }

  // ─────────────────────────────────────────────────────────────────
  // Metrics / introspection
  // ─────────────────────────────────────────────────────────────────

  /** Number of idle connections ready to be acquired. */
  get availableCount(): number {
    return this.available.length;
  }

  /** Number of connections currently in use by active calls. */
  get inUseCount(): number {
    return this.inUse.size;
  }

  /** Total connections managed by the pool (available + in-use). */
  get totalCount(): number {
    return this.available.length + this.inUse.size;
  }

  // ─────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────

  private async createConnection(language: DeepgramLanguage): Promise<DeepgramASRClient> {
    const client = new DeepgramASRClient(language, this.apiKey);
    await client.connect();
    return client;
  }

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
