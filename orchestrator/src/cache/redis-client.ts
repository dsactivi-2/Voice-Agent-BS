import { Redis } from 'ioredis';
import { logger } from '../utils/logger.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://redis:6379';
const MAX_RETRIES = 10;
const BASE_RETRY_DELAY_MS = 100;

/**
 * ioredis client configured with exponential-backoff reconnection.
 * Max 10 retries before the client emits an error and stops retrying.
 */
export const redis = new Redis(REDIS_URL, {
  lazyConnect: false,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy(times: number): number | null {
    if (times > MAX_RETRIES) {
      logger.error(
        { times, redisUrl: REDIS_URL },
        'Redis reconnection exhausted after max retries — giving up',
      );
      return null; // Stop retrying
    }

    const delay = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, times - 1), 30_000);
    logger.warn({ times, delayMs: delay }, 'Redis reconnecting with exponential backoff');
    return delay;
  },
});

redis.on('connect', () => {
  logger.info({ redisUrl: REDIS_URL }, 'Redis TCP connection established');
});

redis.on('ready', () => {
  logger.info({ redisUrl: REDIS_URL }, 'Redis client ready');
});

redis.on('error', (err: Error) => {
  logger.error({ err }, 'Redis client error');
});

redis.on('close', () => {
  logger.warn('Redis connection closed');
});

redis.on('reconnecting', (delay: number) => {
  logger.info({ delayMs: delay }, 'Redis reconnecting');
});

redis.on('end', () => {
  logger.warn('Redis connection ended — no further reconnection attempts');
});

/**
 * Gracefully disconnects the Redis client.
 * Call during application shutdown to ensure all in-flight commands complete.
 */
export async function closeRedis(): Promise<void> {
  logger.info('Closing Redis connection');
  await redis.quit();
  logger.info('Redis connection closed');
}
