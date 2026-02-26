import { logger } from './logger.js';

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  service: string;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { maxRetries, baseDelayMs, service } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) {
        logger.error({ service, attempt, error }, 'All retries exhausted');
        throw error;
      }

      const delay = baseDelayMs * Math.pow(2, attempt);
      logger.warn({ service, attempt, delay, error }, 'Retrying after failure');
      await sleep(delay);
    }
  }

  throw new Error('Unreachable');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { sleep };
