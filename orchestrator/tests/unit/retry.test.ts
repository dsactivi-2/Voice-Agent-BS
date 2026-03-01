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

  it('uses exponential backoff with full jitter', async () => {
    // Pin Math.random to 1 so jitter = cap (worst-case delay) — makes timing deterministic
    vi.spyOn(Math, 'random').mockReturnValue(1);

    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    const start = Date.now();
    await withRetry(fn, { maxRetries: 1, baseDelayMs: 50, service: 'test' });
    const elapsed = Date.now() - start;

    // Math.random = 1 → delay = floor(1 * baseDelay * 2^0) = 50ms
    expect(elapsed).toBeGreaterThanOrEqual(40);

    vi.restoreAllMocks();
  });

  it('jitter produces a value in [0, cap)', async () => {
    const delays: number[] = [];
    const origRandom = Math.random;
    // Sample several random values to verify jitter is applied
    let callCount = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      // Alternate between 0 and 0.5 to verify range
      return callCount++ % 2 === 0 ? 0 : 0.5;
    });

    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('f1'))
      .mockRejectedValueOnce(new Error('f2'))
      .mockResolvedValue('ok');

    // Intercept sleep to capture delays without actually waiting
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../src/utils/retry.js', async () => {
      const mod = await vi.importActual<typeof import('../../src/utils/retry.js')>(
        '../../src/utils/retry.js',
      );
      return mod;
    });

    // We check via logger.warn calls instead
    const { logger } = await import('../../src/utils/logger.js');
    const warnSpy = logger.warn as ReturnType<typeof vi.fn>;
    warnSpy.mockClear();

    await withRetry(fn, { maxRetries: 2, baseDelayMs: 100, service: 'jitter-test' });

    // First retry: cap=100, random=0 → delay=0
    // Second retry: cap=200, random=0.5 → delay=100
    const call0 = warnSpy.mock.calls[0]?.[0] as { delay: number };
    const call1 = warnSpy.mock.calls[1]?.[0] as { delay: number };
    expect(call0.delay).toBe(0);
    expect(call1.delay).toBe(100);

    vi.restoreAllMocks();
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
