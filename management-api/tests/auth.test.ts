import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function buildApp(): Promise<FastifyInstance> {
  // We import dynamically to pick up mocks set in setup.ts
  const { default: Fastify } = await import('fastify');
  const { default: cors } = await import('@fastify/cors');
  const { default: helmet } = await import('@fastify/helmet');
  const { default: rateLimit } = await import('@fastify/rate-limit');
  const { authRoutes, setRedisClient } = await import('../src/auth/routes.js');
  const { healthRoutes } = await import('../src/routes/health.js');

  // Inject an in-memory mock Redis for the auth routes
  const mockRedisStore: Record<string, string> = {};
  setRedisClient({
    get: vi.fn((key: string) => Promise.resolve(mockRedisStore[key] ?? null)),
    set: vi.fn((key: string, value: string, _mode: 'EX', _ttl: number) => {
      mockRedisStore[key] = value;
      return Promise.resolve('OK' as const);
    }),
  });

  const fastify = Fastify({ logger: false, trustProxy: true });

  await fastify.register(cors, { origin: true });
  await fastify.register(helmet, { contentSecurityPolicy: false });
  await fastify.register(rateLimit, { global: false, max: 100, timeWindow: '1 minute' });
  await fastify.register(authRoutes);
  await fastify.register(healthRoutes);

  await fastify.ready();
  return fastify;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_PASSWORD = 'SecurePass123!';
const TEST_EMAIL = 'admin@example.com';
const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_ROLE = 'admin';

async function makePasswordHash(): Promise<string> {
  return bcrypt.hash(TEST_PASSWORD, 4);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with status ok', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; service: string; timestamp: string }>();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('management-api');
    expect(typeof body.timestamp).toBe('string');
  });
});

describe('POST /auth/login', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('returns 200 with accessToken and refreshToken on valid credentials', async () => {
    const { query } = await import('../src/db/pool.js');
    const passwordHash = await makePasswordHash();

    vi.mocked(query).mockResolvedValueOnce({
      rows: [
        {
          id: TEST_USER_ID,
          email: TEST_EMAIL,
          password_hash: passwordHash,
          role: TEST_ROLE,
        },
      ],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      accessToken: string;
      refreshToken: string;
      user: { id: string; email: string; role: string };
    }>();
    expect(typeof body.accessToken).toBe('string');
    expect(body.accessToken.length).toBeGreaterThan(0);
    expect(typeof body.refreshToken).toBe('string');
    expect(body.refreshToken.length).toBeGreaterThan(0);
    expect(body.user.id).toBe(TEST_USER_ID);
    expect(body.user.email).toBe(TEST_EMAIL);
    expect(body.user.role).toBe(TEST_ROLE);
  });

  it('returns 401 on wrong password', async () => {
    const { query } = await import('../src/db/pool.js');
    const passwordHash = await makePasswordHash();

    vi.mocked(query).mockResolvedValueOnce({
      rows: [
        {
          id: TEST_USER_ID,
          email: TEST_EMAIL,
          password_hash: passwordHash,
          role: TEST_ROLE,
        },
      ],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: 'WrongPassword!' }),
    });

    expect(response.statusCode).toBe(401);
    const body = response.json<{ code: string }>();
    expect(body.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 401 on unknown email (user not found)', async () => {
    const { query } = await import('../src/db/pool.js');

    vi.mocked(query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nonexistent@example.com', password: 'AnyPassword123!' }),
    });

    expect(response.statusCode).toBe(401);
    const body = response.json<{ code: string }>();
    expect(body.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 400 on invalid body (missing password)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL }),
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ code: string }>();
    expect(body.code).toBe('INVALID_BODY');
  });

  it('returns 400 on invalid body (malformed email)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'ValidPass123!' }),
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ code: string }>();
    expect(body.code).toBe('INVALID_BODY');
  });

  it('returns 400 on invalid body (password too short)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: 'short' }),
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ code: string }>();
    expect(body.code).toBe('INVALID_BODY');
  });
});

describe('POST /auth/refresh', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('returns 200 with new accessToken on valid refresh token', async () => {
    // First get a real refresh token via login flow
    const { signRefreshToken } = await import('../src/auth/jwt.js');
    const { query } = await import('../src/db/pool.js');

    const refreshToken = signRefreshToken({ userId: TEST_USER_ID });

    vi.mocked(query).mockResolvedValueOnce({
      rows: [{ id: TEST_USER_ID, email: TEST_EMAIL, role: TEST_ROLE }],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ accessToken: string }>();
    expect(typeof body.accessToken).toBe('string');
    expect(body.accessToken.length).toBeGreaterThan(0);
  });

  it('returns 401 on invalid (tampered) refresh token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'invalid.jwt.token' }),
    });

    expect(response.statusCode).toBe(401);
    const body = response.json<{ code: string }>();
    expect(body.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('returns 400 on missing refreshToken in body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ code: string }>();
    expect(body.code).toBe('INVALID_BODY');
  });
});

describe('POST /auth/logout', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('returns 200 success on valid logout', async () => {
    const { signAccessToken, signRefreshToken } = await import('../src/auth/jwt.js');

    const accessToken = signAccessToken({
      userId: TEST_USER_ID,
      email: TEST_EMAIL,
      role: TEST_ROLE,
    });
    const refreshToken = signRefreshToken({ userId: TEST_USER_ID });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ refreshToken }),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ success: boolean }>();
    expect(body.success).toBe(true);
  });

  it('returns 401 when Authorization header is missing', async () => {
    const { signRefreshToken } = await import('../src/auth/jwt.js');
    const refreshToken = signRefreshToken({ userId: TEST_USER_ID });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    expect(response.statusCode).toBe(401);
  });
});
