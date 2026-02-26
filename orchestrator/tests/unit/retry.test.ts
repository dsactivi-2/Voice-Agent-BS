import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withRetry, sleep } from '../../src/utils/retry.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('withRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10, service: 'test' });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10, service: 'test' });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after all retries exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 10, service: 'test' })
    ).rejects.toThrow('always fails');

    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('uses exponential backoff delay', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    const start = Date.now();
    await withRetry(fn, { maxRetries: 1, baseDelayMs: 50, service: 'test' });
    const elapsed = Date.now() - start;

    // Should have waited at least 50ms (baseDelay * 2^0 = 50ms)
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('works with 0 retries — throws immediately', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('no retry'));

    await expect(
      withRetry(fn, { maxRetries: 0, baseDelayMs: 10, service: 'test' })
    ).rejects.toThrow('no retry');

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('sleep', () => {
  it('resolves after specified duration', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});
