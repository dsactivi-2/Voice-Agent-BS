import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mock fns ──────────────────────────────────────────────────────────
//
// vi.hoisted() runs BEFORE vi.mock() factory evaluation, which means we can
// reference these variables safely inside the factory even though vi.mock() is
// hoisted to the top of the module by Vitest's transform.

const { mockGet, mockSet, mockTtl, mockQuit, mockOn, mockConfig } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(),
  mockTtl: vi.fn(),
  mockQuit: vi.fn(),
  mockOn: vi.fn(),
  mockConfig: {
    ANTI_LOOP_COOLDOWN_HOURS: 24,
    TTS_CACHE_TTL_SECONDS: 86400,
    ANTI_LOOP_BYPASS_NUMBERS: '',
  },
}));

// ── ioredis mock ──────────────────────────────────────────────────────────────

vi.mock('ioredis', () => {
  function MockRedis() {
    return {
      get: mockGet,
      set: mockSet,
      ttl: mockTtl,
      quit: mockQuit,
      on: mockOn,
    };
  }
  // Export both named and default so the mock works regardless of which import
  // style the source file uses (import { Redis } or import Redis from 'ioredis').
  return { Redis: MockRedis, default: MockRedis };
});

// ── Config + logger mocks ─────────────────────────────────────────────────────

vi.mock('../../src/config.js', () => ({
  config: mockConfig,
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

// ── Module under test ─────────────────────────────────────────────────────────

import { canCallNumber, markCallMade } from '../../src/session/anti-loop.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PHONE = '+38761123456';

function redisKey(phone: string): string {
  return `anti-loop:cooldown:${phone.replace(/\W/g, '')}`;
}

// ── canCallNumber ─────────────────────────────────────────────────────────────

describe('canCallNumber', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns true for a new number (no cooldown key in Redis)', async () => {
    mockGet.mockResolvedValueOnce(null);

    const result = await canCallNumber(PHONE);

    expect(result).toBe(true);
    expect(mockGet).toHaveBeenCalledOnce();
    expect(mockGet).toHaveBeenCalledWith(redisKey(PHONE));
  });

  it('returns false when a cooldown record exists', async () => {
    mockGet.mockResolvedValueOnce('1');
    mockTtl.mockResolvedValueOnce(82000); // ~22.7 hours remaining

    const result = await canCallNumber(PHONE);

    expect(result).toBe(false);
    expect(mockGet).toHaveBeenCalledWith(redisKey(PHONE));
  });

  it('returns true (fail-open) when Redis throws an error', async () => {
    mockGet.mockRejectedValueOnce(new Error('Redis connection refused'));

    const result = await canCallNumber(PHONE);

    // On Redis failure we allow the call rather than silently blocking it
    expect(result).toBe(true);
  });

  it('normalises phone numbers with special characters before building the key', async () => {
    mockGet.mockResolvedValueOnce(null);

    const phoneDashes = '+386-61-123-456';
    await canCallNumber(phoneDashes);

    const expectedKey = `anti-loop:cooldown:${phoneDashes.replace(/\W/g, '')}`;
    expect(mockGet).toHaveBeenCalledWith(expectedKey);
  });
});

// ── markCallMade ──────────────────────────────────────────────────────────────

describe('markCallMade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sets the Redis key with the correct TTL derived from ANTI_LOOP_COOLDOWN_HOURS', async () => {
    mockSet.mockResolvedValueOnce('OK');

    await markCallMade(PHONE);

    const expectedTtlSeconds = 24 * 3600; // 86400
    expect(mockSet).toHaveBeenCalledOnce();
    expect(mockSet).toHaveBeenCalledWith(
      redisKey(PHONE),
      '1',
      'EX',
      expectedTtlSeconds,
    );
  });

  it('sets the key so that a subsequent canCallNumber call returns false', async () => {
    // markCallMade writes the key
    mockSet.mockResolvedValueOnce('OK');
    await markCallMade(PHONE);

    // canCallNumber now finds it
    mockGet.mockResolvedValueOnce('1');
    mockTtl.mockResolvedValueOnce(86000);

    const allowed = await canCallNumber(PHONE);
    expect(allowed).toBe(false);
  });

  it('throws when Redis set fails', async () => {
    mockSet.mockRejectedValueOnce(
      new Error('READONLY You cannot write against a read only replica'),
    );

    await expect(markCallMade(PHONE)).rejects.toThrow('READONLY');
  });

  it('uses normalised phone number as part of the Redis key', async () => {
    mockSet.mockResolvedValueOnce('OK');

    const phoneWithParens = '+1 (555) 123-4567';
    await markCallMade(phoneWithParens);

    const expectedKey = `anti-loop:cooldown:${phoneWithParens.replace(/\W/g, '')}`;
    expect(mockSet).toHaveBeenCalledWith(expectedKey, '1', 'EX', 24 * 3600);
  });
});

// ── Bypass list ───────────────────────────────────────────────────────────────

describe('bypass list', () => {
  const BYPASS_PHONE = '+14155550100';

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.ANTI_LOOP_BYPASS_NUMBERS = '';
    // Default Redis behaviour: no cooldown (not blocked).
    // Must be set after clearAllMocks because clearAllMocks resets the once-queue.
    mockGet.mockResolvedValue(null);
  });

  afterEach(() => {
    mockConfig.ANTI_LOOP_BYPASS_NUMBERS = '';
  });

  it('canCallNumber returns true for a bypassed number without hitting Redis', async () => {
    mockConfig.ANTI_LOOP_BYPASS_NUMBERS = BYPASS_PHONE;
    // Even if Redis would say blocked, bypass takes precedence
    mockGet.mockResolvedValueOnce('1');

    const result = await canCallNumber(BYPASS_PHONE);

    expect(result).toBe(true);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('markCallMade skips Redis write for a bypassed number', async () => {
    mockConfig.ANTI_LOOP_BYPASS_NUMBERS = BYPASS_PHONE;

    await markCallMade(BYPASS_PHONE);

    expect(mockSet).not.toHaveBeenCalled();
  });

  it('accepts multiple bypass numbers separated by commas', async () => {
    const second = '+4915123456789';
    mockConfig.ANTI_LOOP_BYPASS_NUMBERS = `${BYPASS_PHONE},${second}`;

    expect(await canCallNumber(BYPASS_PHONE)).toBe(true);
    expect(await canCallNumber(second)).toBe(true);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('normalises bypass numbers so format differences still match', async () => {
    // Stored with dashes, incoming without
    mockConfig.ANTI_LOOP_BYPASS_NUMBERS = '+1-415-555-0100';

    const result = await canCallNumber('+14155550100');

    expect(result).toBe(true);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('empty ANTI_LOOP_BYPASS_NUMBERS bypasses nobody', async () => {
    mockConfig.ANTI_LOOP_BYPASS_NUMBERS = '';
    mockGet.mockResolvedValueOnce(null);

    await canCallNumber(BYPASS_PHONE);

    expect(mockGet).toHaveBeenCalledOnce();
  });
});
