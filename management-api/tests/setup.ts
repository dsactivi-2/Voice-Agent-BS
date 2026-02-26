import { vi, beforeAll, afterAll } from 'vitest';

// ─── Environment ──────────────────────────────────────────────────────────────

// Set environment variables BEFORE any module is imported that reads them.
process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
process.env['REDIS_URL'] = 'redis://localhost:6379';
process.env['JWT_SECRET'] = 'test-jwt-secret-must-be-at-least-32-chars!!';
process.env['JWT_REFRESH_SECRET'] = 'test-refresh-secret-must-be-32-chars!!';
process.env['JWT_ACCESS_TTL'] = '15m';
process.env['JWT_REFRESH_TTL'] = '7d';
process.env['PORT'] = '3099';
process.env['LOG_LEVEL'] = 'silent';
process.env['BCRYPT_ROUNDS'] = '4'; // Fast rounds for tests

// ─── pg Pool mock ─────────────────────────────────────────────────────────────

vi.mock('../src/db/pool.js', () => {
  const queryMock = vi.fn();
  const poolMock = {
    query: vi.fn(),
    on: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  };

  return {
    pool: poolMock,
    query: queryMock,
    closePool: vi.fn().mockResolvedValue(undefined),
  };
});

// ─── ioredis mock ─────────────────────────────────────────────────────────────

vi.mock('ioredis', () => {
  const RedisMock = vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    quit: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  }));

  return { default: RedisMock };
});

beforeAll(() => {
  // Silence pino output during tests
  process.env['LOG_LEVEL'] = 'silent';
});

afterAll(() => {
  vi.restoreAllMocks();
});
