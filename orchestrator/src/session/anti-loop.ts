import { redis } from '../cache/redis-client.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** Redis key prefix for anti-loop cooldown records. */
const KEY_PREFIX = 'anti-loop:cooldown:';

/**
 * Builds the Redis key for a given phone number.
 * Strips all non-alphanumeric characters to normalise the key.
 */
function buildKey(phoneNumber: string): string {
  const normalised = phoneNumber.replace(/\W/g, '');
  return `${KEY_PREFIX}${normalised}`;
}

/**
 * Checks whether calling the given phone number is currently allowed.
 * Returns false if a cooldown record exists in Redis, true otherwise.
 *
 * @param phoneNumber - E.164 or any phone number string
 * @returns true when the number may be called; false when blocked by cooldown
 */
export async function canCallNumber(phoneNumber: string): Promise<boolean> {
  const key = buildKey(phoneNumber);
  try {
    const value = await redis.get(key);
    const blocked = value !== null;

    if (blocked) {
      const ttl = await redis.ttl(key);
      logger.warn(
        { phoneNumber, remainingTtlSeconds: ttl },
        'Call blocked by anti-loop cooldown',
      );
    }

    return !blocked;
  } catch (err) {
    // On Redis failure, allow the call so we don't block the pipeline
    logger.error({ err, phoneNumber }, 'Failed to check anti-loop cooldown — allowing call');
    return true;
  }
}

/**
 * Records that a call was made to the given phone number and starts the
 * cooldown period.  Subsequent calls to canCallNumber will return false
 * until the TTL expires.
 *
 * @param phoneNumber - E.164 or any phone number string
 */
export async function markCallMade(phoneNumber: string): Promise<void> {
  const key = buildKey(phoneNumber);
  const ttlSeconds = config.ANTI_LOOP_COOLDOWN_HOURS * 3_600;

  try {
    await redis.set(key, '1', 'EX', ttlSeconds);
    logger.info(
      { phoneNumber, cooldownHours: config.ANTI_LOOP_COOLDOWN_HOURS, ttlSeconds },
      'Anti-loop cooldown set for phone number',
    );
  } catch (err) {
    logger.error({ err, phoneNumber }, 'Failed to set anti-loop cooldown');
    throw err;
  }
}
