import { describe, it, expect, beforeAll, vi, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';

// Mock child_process
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// Mock database pool
vi.mock('../../src/db/pool.js', () => ({
  query: vi.fn(),
  closePool: vi.fn(),
}));

// Mock logger
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock redis
vi.mock('../../src/utils/redis.js', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    disconnect: vi.fn(),
  },
}));

// Mock auth middleware
vi.mock('../../src/middleware/auth.js', () => ({
  authenticate: vi.fn(async (request, _reply) => {
    request.user = { userId: '1', email: 'admin@activi.io', role: 'admin' };
  }),
  requireRole: vi.fn(() => vi.fn()),
}));

const { query } = await import('../../src/db/pool.js');
const { redis } = await import('../../src/utils/redis.js');
const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

describe('POST /optimize', () => {
  beforeAll(() => {
    // Set required env vars
    process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/test';
    process.env['JWT_SECRET'] = 'test-secret-32-characters-long!';
    process.env['JWT_REFRESH_SECRET'] = 'test-refresh-secret-32-chars!';
    process.env['OPENAI_API_KEY'] = 'sk-test';
  });

  afterAll(() => {
    vi.clearAllMocks();
  });

  it('should execute cache_warmup successfully', async () => {
    // Mock Redis responses
    vi.mocked(redis.get).mockResolvedValue('base64encodedaudio');

    const { optimizeRoutes } = await import('../../src/routes/optimize.js');
    const Fastify = await import('fastify');
    const app = Fastify.default({ logger: false });

    await app.register(optimizeRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/optimize',
      payload: {
        type: 'cache_warmup',
        agent: 'all',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.optimizationType).toBe('cache_warmup');
    expect(body.details).toHaveProperty('phrasesWarmed');
    expect(body.riskLevel).toBe('LOW');

    await app.close();
  });

  it('should execute cleanup in dry-run mode', async () => {
    // Mock database count query
    vi.mocked(query).mockResolvedValueOnce({
      rows: [{ count: '42' }],
      rowCount: 1,
    } as never);

    const { optimizeRoutes } = await import('../../src/routes/optimize.js');
    const Fastify = await import('fastify');
    const app = Fastify.default({ logger: false });

    await app.register(optimizeRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/optimize',
      payload: {
        type: 'cleanup',
        dryRun: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.details.recordsDeleted).toBe(42);
    expect(body.riskLevel).toBe('MEDIUM');

    await app.close();
  });

  it('should execute db_optimize successfully', async () => {
    // Mock table size queries
    vi.mocked(query)
      .mockResolvedValueOnce({
        rows: [
          { table_name: 'calls', size_bytes: '156000000' },
          { table_name: 'turns', size_bytes: '42000000' },
        ],
        rowCount: 2,
      } as never)
      .mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as never) // VACUUM (no result)
      .mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as never) // VACUUM (no result)
      .mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as never) // VACUUM (no result)
      .mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as never) // VACUUM (no result)
      .mockResolvedValueOnce({
        rows: [
          { table_name: 'calls', size_bytes: '142000000' },
          { table_name: 'turns', size_bytes: '38000000' },
        ],
        rowCount: 2,
      } as never);

    const { optimizeRoutes } = await import('../../src/routes/optimize.js');
    const Fastify = await import('fastify');
    const app = Fastify.default({ logger: false });

    await app.register(optimizeRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/optimize',
      payload: {
        type: 'db_optimize',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.details).toHaveProperty('tables');
    expect(body.details).toHaveProperty('improvement');

    await app.close();
  });

  it('should execute restart in dry-run mode', async () => {
    const { optimizeRoutes } = await import('../../src/routes/optimize.js');
    const Fastify = await import('fastify');
    const app = Fastify.default({ logger: false });

    await app.register(optimizeRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/optimize',
      payload: {
        type: 'restart',
        dryRun: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.riskLevel).toBe('HIGH');
    expect(body.details.healthCheck).toBe('skipped (dry run)');

    await app.close();
  });

  it('should execute restart successfully for admin', async () => {
    // Mock successful Docker compose restart
    const mockProc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, handler: (code: number) => void) => {
        if (event === 'close') {
          handler(0); // Success exit code
        }
      }),
    } as unknown as EventEmitter;

    spawnMock.mockReturnValueOnce(mockProc as never);

    const { optimizeRoutes } = await import('../../src/routes/optimize.js');
    const Fastify = await import('fastify');
    const app = Fastify.default({ logger: false });

    await app.register(optimizeRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/optimize',
      payload: {
        type: 'restart',
        dryRun: false,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.details).toHaveProperty('services');
    expect(body.details.services).toContain('orchestrator');

    await app.close();
  });

  it('should reject HIGH risk operation for non-admin', async () => {
    // Override auth mock for this test
    const { authenticate } = await import('../../src/middleware/auth.js');
    vi.mocked(authenticate).mockImplementationOnce(async (request, _reply) => {
      request.user = { userId: '2', email: 'user@activi.io', role: 'user' };
    });

    const { optimizeRoutes } = await import('../../src/routes/optimize.js');
    const Fastify = await import('fastify');
    const app = Fastify.default({ logger: false });

    await app.register(optimizeRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/optimize',
      payload: {
        type: 'restart',
      },
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('INSUFFICIENT_PERMISSIONS');

    await app.close();
  });

  it('should execute update_prompts successfully', async () => {
    // Mock database response
    vi.mocked(query)
      .mockResolvedValueOnce({
        rows: [
          { id: '1', name: 'system_prompt', version: 2 },
          { id: '2', name: 'qualify_prompt', version: 2 },
        ],
        rowCount: 2,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ id: '3', name: 'system_prompt', version: 2 }],
        rowCount: 1,
      } as never);

    const { optimizeRoutes } = await import('../../src/routes/optimize.js');
    const Fastify = await import('fastify');
    const app = Fastify.default({ logger: false });

    await app.register(optimizeRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/optimize',
      payload: {
        type: 'update_prompts',
        agent: 'all',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.details.promptsUpdated).toBe(3);
    expect(body.details.version).toBe('v2.0.0');

    await app.close();
  });

  it('should return 400 for invalid optimization type', async () => {
    const { optimizeRoutes } = await import('../../src/routes/optimize.js');
    const Fastify = await import('fastify');
    const app = Fastify.default({ logger: false });

    await app.register(optimizeRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/optimize',
      payload: {
        type: 'invalid_type',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('INVALID_BODY');

    await app.close();
  });

  it('should infer risk level correctly', async () => {
    const { optimizeRoutes } = await import('../../src/routes/optimize.js');
    const Fastify = await import('fastify');
    const app = Fastify.default({ logger: false });

    // Mock Redis for cache_warmup
    vi.mocked(redis.get).mockResolvedValue('data');

    await app.register(optimizeRoutes);

    // Test LOW risk (cache_warmup)
    let response = await app.inject({
      method: 'POST',
      url: '/optimize',
      payload: { type: 'cache_warmup' },
    });
    expect(JSON.parse(response.body).riskLevel).toBe('LOW');

    // Test MEDIUM risk (cleanup) - mock DB query
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);
    response = await app.inject({
      method: 'POST',
      url: '/optimize',
      payload: { type: 'cleanup', dryRun: true },
    });
    expect(JSON.parse(response.body).riskLevel).toBe('MEDIUM');

    // Test HIGH risk (restart)
    response = await app.inject({
      method: 'POST',
      url: '/optimize',
      payload: { type: 'restart', dryRun: true },
    });
    expect(JSON.parse(response.body).riskLevel).toBe('HIGH');

    await app.close();
  });
});
