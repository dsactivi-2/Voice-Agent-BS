import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerHealthRoute } from '../../src/health.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

function createMockPool(healthy = true) {
  return {
    query: healthy
      ? vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] })
      : vi.fn().mockRejectedValue(new Error('DB down')),
  } as unknown as import('pg').Pool;
}

function createMockRedis(healthy = true) {
  return {
    ping: healthy
      ? vi.fn().mockResolvedValue('PONG')
      : vi.fn().mockRejectedValue(new Error('Redis down')),
  } as unknown as import('ioredis').default;
}

describe('Health Check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock fetch for external service checks
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  });

  it('returns healthy when all services are up', async () => {
    const app = Fastify();
    registerHealthRoute(app, {
      dbPool: createMockPool(true),
      redis: createMockRedis(true),
      getActiveCalls: () => 0,
      version: '0.1.0',
      startedAt: Date.now(),
    });

    const response = await app.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(response.body) as { status: string; activeCalls: number; version: string };

    expect(response.statusCode).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.activeCalls).toBe(0);
    expect(body.version).toBe('0.1.0');
  });

  it('returns unhealthy when postgres is down', async () => {
    const app = Fastify();
    registerHealthRoute(app, {
      dbPool: createMockPool(false),
      redis: createMockRedis(true),
      getActiveCalls: () => 3,
      version: '0.1.0',
      startedAt: Date.now(),
    });

    const response = await app.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(response.body) as { status: string; activeCalls: number };

    expect(response.statusCode).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.activeCalls).toBe(3);
  });

  it('returns unhealthy when redis is down', async () => {
    const app = Fastify();
    registerHealthRoute(app, {
      dbPool: createMockPool(true),
      redis: createMockRedis(false),
      getActiveCalls: () => 0,
      version: '0.1.0',
      startedAt: Date.now(),
    });

    const response = await app.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(response.body) as { status: string };

    expect(response.statusCode).toBe(503);
    expect(body.status).toBe('unhealthy');
  });

  it('reports correct uptime', async () => {
    const startedAt = Date.now() - 60000; // 60 seconds ago
    const app = Fastify();
    registerHealthRoute(app, {
      dbPool: createMockPool(true),
      redis: createMockRedis(true),
      getActiveCalls: () => 0,
      version: '0.1.0',
      startedAt,
    });

    const response = await app.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(response.body) as { uptime: number };

    expect(body.uptime).toBeGreaterThanOrEqual(59);
    expect(body.uptime).toBeLessThanOrEqual(62);
  });

  it('includes all service checks in response', async () => {
    const app = Fastify();
    registerHealthRoute(app, {
      dbPool: createMockPool(true),
      redis: createMockRedis(true),
      getActiveCalls: () => 0,
      version: '0.1.0',
      startedAt: Date.now(),
    });

    const response = await app.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(response.body) as { checks: Record<string, { status: string; latencyMs: number }> };

    expect(body.checks).toHaveProperty('postgres');
    expect(body.checks).toHaveProperty('redis');
    expect(body.checks).toHaveProperty('deepgram');
    expect(body.checks).toHaveProperty('azureTts');
    expect(body.checks).toHaveProperty('openai');
    expect(body.checks['postgres']?.status).toBe('ok');
    expect(body.checks['redis']?.status).toBe('ok');
  });
});
