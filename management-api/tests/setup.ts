import { vi, beforeAll, afterAll } from 'vitest';

// ─── Environment — set BEFORE any module import ───────────────────────────────
// Vitest runs setup files first, so these vars will be present when
// config.ts is evaluated.

process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
process.env['REDIS_URL'] = 'redis://localhost:6379';
process.env['JWT_SECRET'] = 'test-jwt-secret-must-be-at-least-32-chars!!';
process.env['JWT_REFRESH_SECRET'] = 'test-refresh-secret-must-be-32-chars!!';
process.env['JWT_ACCESS_TTL'] = '15m';
process.env['JWT_REFRESH_TTL'] = '7d';
process.env['PORT'] = '3099';
process.env['LOG_LEVEL'] = 'error'; // valid pino level — suppress most output during tests
process.env['BCRYPT_ROUNDS'] = '4'; // Fast rounds for tests
process.env['OPENAI_API_KEY'] = 'sk-test-not-real-key-for-unit-tests-only';

// ─── pg Pool mock ─────────────────────────────────────────────────────────────
// Mock the entire pool module so no real DB connection is attempted.

vi.mock('../src/db/pool.js', () => {
  const queryMock = vi.fn();
  const poolMock = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    on: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  };

  return {
    pool: poolMock,
    query: queryMock,
    closePool: vi.fn().mockResolvedValue(undefined),
  };
});

// ─── ioredis mock — prevent real Redis connections ────────────────────────────

vi.mock('ioredis', () => {
  class RedisMock {
    on(_event: string, _handler: unknown) { return this; }
    get(_key: string): Promise<string | null> { return Promise.resolve(null); }
    set(_key: string, _value: string, _mode: string, _ttl: number): Promise<string | null> { return Promise.resolve('OK'); }
    publish(_channel: string, _message: string): Promise<number> { return Promise.resolve(0); }
    subscribe(_channel: string): Promise<number> { return Promise.resolve(1); }
    connect(): Promise<void> { return Promise.resolve(); }
    quit(): Promise<void> { return Promise.resolve(); }
    disconnect(): void { /* noop */ }
  }

  return { Redis: RedisMock };
});

// ─── utils/redis mock — prevent config being read at module import ────────────

vi.mock('../src/utils/redis.js', () => {
  return {
    redis: {
      on: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      quit: vi.fn().mockResolvedValue(undefined),
    },
  };
});

beforeAll(() => {
  // Intentionally empty — env vars are set at module level above.
});

// Reset all mock call history and queued return values before each test
// so unconsumed mockResolvedValueOnce calls don't bleed into subsequent tests.
beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});
