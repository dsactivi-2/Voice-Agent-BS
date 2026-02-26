import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from './logger.js';

export const redis = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
});

redis.on('connect', () => {
  logger.info('Redis TCP connection established');
});

redis.on('error', (err: Error) => {
  logger.error({ err }, 'Redis client error');
});

export type RedisClientType = Redis;
