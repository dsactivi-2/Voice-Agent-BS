import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mock fns ──────────────────────────────────────────────────────────
//
// vi.hoisted() runs BEFORE vi.mock() factory evaluation, which means we can
// reference these variables safely inside the factory even though vi.mock() is
// hoisted to the top of the module by Vitest's transform.

const { mockGet, mockSet, mockTtl, mockQuit, mockOn } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(),
  mockTtl: vi.fn(),
  mockQuit: vi.fn(),
  mockOn: vi.fn(),
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
  config: {
    ANTI_LOOP_COOLDOWN_HOURS: 24,
    TTS_CACHE_TTL_SECONDS: 86400,
  },
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
