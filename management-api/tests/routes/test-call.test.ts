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
const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

describe('POST /api/test-call', () => {
  beforeAll(() => {
    // Set required env vars
    process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/test';
    process.env['JWT_SECRET'] = 'test-secret-32-characters-long!';
    process.env['JWT_REFRESH_SECRET'] = 'test-refresh-secret-32-chars!';
    process.env['OPENAI_API_KEY'] = 'sk-test';
    process.env['AZURE_SPEECH_KEY'] = 'test-azure-key';
    process.env['AZURE_REGION'] = 'westeurope';
  });

  afterAll(() => {
    vi.clearAllMocks();
  });

  it('should execute test call successfully with default profile', async () => {
    // Mock database response
    vi.mocked(query).mockResolvedValueOnce({
      rows: [{ id: '7173ac81-d68e-40a1-852f-db2a413e4e79', name: 'Goran', language: 'bs-BA', tts_voice: 'bs-BA-GoranNeural' }],
      rowCount: 1,
    } as never);

    // Mock successful Docker spawn
    const mockProc = {
      stdout: {
        on: vi.fn((event: string, handler: (data: Buffer) => void) => {
          if (event === 'data') {
            // Simulate JSON output
            const output = JSON.stringify({
              success: true,
              callId: 'call_123',
              profile: 'interested',
              phoneNumber: '+1234567890',
              agent: 'goran',
              duration: 45,
              turns: 5,
              transcript: [
                { speaker: 'agent', text: 'Dobar dan! Zovem se Goran iz Step Tu Džob-a.' },
                { speaker: 'customer', text: 'Dobar dan.' },
              ],
              metrics: {
                totalDuration: 45,
                ttsLatency: 320,
                asrAccuracy: 0.97,
                turnCount: 5,
              },
              outcome: 'completed',
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            });
            handler(Buffer.from(output));
          }
        }),
      },
      stderr: {
        on: vi.fn(),
      },
      on: vi.fn((event: string, handler: (code: number) => void) => {
        if (event === 'close') {
          handler(0); // Success exit code
        }
      }),
    } as unknown as EventEmitter;

    spawnMock.mockReturnValueOnce(mockProc as never);

    const { testCallRoutes } = await import('../../src/routes/test-call.js');
    const Fastify = await import('fastify');
    const app = Fastify.default({ logger: false });

    await app.register(testCallRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/api/test-call',
      payload: {
        profile: 'interested',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.callId).toBe('call_123');
    expect(body.agentUsed).toEqual({
      id: '7173ac81-d68e-40a1-852f-db2a413e4e79',
      name: 'Goran',
      language: 'bs-BA',
      ttsVoice: 'bs-BA-GoranNeural',
    });

    await app.close();
  });

  it('should return 404 if agent not found', async () => {
    // Mock empty database response
    vi.mocked(query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
    } as never);

    const { testCallRoutes } = await import('../../src/routes/test-call.js');
    const Fastify = await import('fastify');
    const app = Fastify.default({ logger: false });

    await app.register(testCallRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/api/test-call',
      payload: {
        profile: 'interested',
        agentId: '00000000-0000-4000-8000-000000000999',
      },
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('AGENT_NOT_FOUND');

    await app.close();
  });

  it('should return 400 for invalid profile', async () => {
    const { testCallRoutes } = await import('../../src/routes/test-call.js');
    const Fastify = await import('fastify');
    const app = Fastify.default({ logger: false });

    await app.register(testCallRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/api/test-call',
      payload: {
        profile: 'invalid-profile',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('INVALID_BODY');

    await app.close();
  });

  it('should handle Docker execution error', async () => {
    // Mock database response
    vi.mocked(query).mockResolvedValueOnce({
      rows: [{ id: '7173ac81-d68e-40a1-852f-db2a413e4e79', name: 'Goran', language: 'bs-BA', tts_voice: 'bs-BA-GoranNeural' }],
      rowCount: 1,
    } as never);

    // Mock Docker spawn error
    const mockProc = {
      stdout: { on: vi.fn() },
      stderr: {
        on: vi.fn((event: string, handler: (data: Buffer) => void) => {
          if (event === 'data') {
            handler(Buffer.from('Docker error'));
          }
        }),
      },
      on: vi.fn((event: string, handler: (code: number | Error) => void) => {
        if (event === 'close') {
          handler(1); // Error exit code
        }
      }),
    } as unknown as EventEmitter;

    spawnMock.mockReturnValueOnce(mockProc as never);

    const { testCallRoutes } = await import('../../src/routes/test-call.js');
    const Fastify = await import('fastify');
    const app = Fastify.default({ logger: false });

    await app.register(testCallRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/api/test-call',
      payload: {
        profile: 'interested',
      },
    });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('EXECUTION_ERROR');

    await app.close();
  });

  it('should validate maxDuration range', async () => {
    const { testCallRoutes } = await import('../../src/routes/test-call.js');
    const Fastify = await import('fastify');
    const app = Fastify.default({ logger: false });

    await app.register(testCallRoutes);

    // Test below minimum
    let response = await app.inject({
      method: 'POST',
      url: '/api/test-call',
      payload: {
        profile: 'interested',
        maxDuration: 5,
      },
    });

    expect(response.statusCode).toBe(400);

    // Test above maximum
    response = await app.inject({
      method: 'POST',
      url: '/api/test-call',
      payload: {
        profile: 'interested',
        maxDuration: 700,
      },
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });
});
