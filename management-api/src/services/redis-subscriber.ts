import { Redis } from 'ioredis';
import { logger } from '../utils/logger.js';
import { eventStreamManager } from './event-stream.js';
import type { CallEvent } from './event-stream.js';

const CHANNEL = 'call-events';

let subscriber: Redis | null = null;

/**
 * Creates a dedicated Redis subscriber connection and subscribes to the
 * call-events channel. Forwards all received messages to the EventStreamManager.
 *
 * NOTE: ioredis requires a separate connection for subscribe mode — the
 * regular redis client cannot be reused once in subscriber mode.
 */
export async function startRedisSubscriber(redisUrl: string): Promise<void> {
  subscriber = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: null, // required for subscriber connections
    enableReadyCheck: false,
  });

  subscriber.on('error', (err: Error) => {
    logger.error({ err }, 'Redis subscriber connection error');
  });

  subscriber.on('reconnecting', () => {
    logger.info('Redis subscriber reconnecting');
  });

  await subscriber.connect();
  await subscriber.subscribe(CHANNEL);

  subscriber.on('message', (channel: string, message: string) => {
    if (channel !== CHANNEL) return;

    try {
      const event = JSON.parse(message) as CallEvent;
      eventStreamManager.broadcast(event);
    } catch (err) {
      logger.warn({ err, message }, 'Failed to parse call event from Redis channel');
    }
  });

  logger.info({ channel: CHANNEL }, 'Redis subscriber started and listening for call events');
}

/**
 * Gracefully disconnects the subscriber. Call during application shutdown.
 */
export async function stopRedisSubscriber(): Promise<void> {
  if (subscriber) {
    await subscriber.quit();
    subscriber = null;
    logger.info('Redis subscriber stopped');
  }
}
