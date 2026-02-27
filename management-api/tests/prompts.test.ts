import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { signAccessToken } from '../src/auth/jwt.js';

// ─── Mock query ───────────────────────────────────────────────────────────────

import { query } from '../src/db/pool.js';
const queryMock = vi.mocked(query);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function buildApp(): Promise<FastifyInstance> {
  const { default: Fastify } = await import('fastify');
  const { default: cors } = await import('@fastify/cors');
  const { default: helmet } = await import('@fastify/helmet');
  const { default: rateLimit } = await import('@fastify/rate-limit');
  const { promptRoutes } = await import('../src/routes/prompts.js');

  const fastify = Fastify({ logger: false, trustProxy: true });
  await fastify.register(cors, { origin: true });
  await fastify.register(helmet, { contentSecurityPolicy: false });
  await fastify.register(rateLimit, { global: false, max: 100, timeWindow: '1 minute' });
  await fastify.register(promptRoutes);
  await fastify.ready();
  return fastify;
}

function adminToken(): string {
  return `Bearer ${signAccessToken({ userId: 'user-1', email: 'admin@test.com', role: 'admin' })}`;
}

function managerToken(): string {
  return `Bearer ${signAccessToken({ userId: 'user-2', email: 'manager@test.com', role: 'manager' })}`;
}

function viewerToken(): string {
  return `Bearer ${signAccessToken({ userId: 'user-3', email: 'viewer@test.com', role: 'viewer' })}`;
}

const SAMPLE_PROMPT = {
  id: '660e8400-e29b-41d4-a716-446655440001',
  name: 'hook-bs-BA-v1',
  language: 'bs-BA',
  phase: 'hook',
  content: 'Zdravo! Zovem se Goran...',
  version: 1,
  is_active: true,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /prompts', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'GET', url: '/prompts' });
    expect(res.statusCode).toBe(401);
  });

  it('returns prompt list for authenticated viewer', async () => {
    queryMock.mockResolvedValueOnce({ rows: [SAMPLE_PROMPT], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'GET',
      url: '/prompts',
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ prompts: typeof SAMPLE_PROMPT[]; total: number }>();
    expect(body.total).toBe(1);
    expect(body.prompts[0]?.name).toBe('hook-bs-BA-v1');
  });

  it('filters by language and phase', async () => {
    queryMock.mockResolvedValueOnce({ rows: [SAMPLE_PROMPT], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'GET',
      url: '/prompts?language=bs-BA&phase=hook',
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 for invalid phase', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/prompts?phase=greeting',
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /prompts/:id', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns prompt when found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [SAMPLE_PROMPT], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'GET',
      url: `/prompts/${SAMPLE_PROMPT.id}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ prompt: typeof SAMPLE_PROMPT }>().prompt.phase).toBe('hook');
  });

  it('returns 404 when not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'GET',
      url: `/prompts/${SAMPLE_PROMPT.id}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for non-UUID id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/prompts/not-a-uuid',
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /prompts/name/:name/versions', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns all versions of a named prompt', async () => {
    const v2 = { ...SAMPLE_PROMPT, id: '660e8400-e29b-41d4-a716-446655440002', version: 2 };
    queryMock.mockResolvedValueOnce({ rows: [v2, SAMPLE_PROMPT], rowCount: 2 } as never);
    const res = await app.inject({
      method: 'GET',
      url: '/prompts/name/hook-bs-BA-v1/versions',
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ versions: typeof SAMPLE_PROMPT[]; total: number }>();
    expect(body.total).toBe(2);
    expect(body.versions[0]?.version).toBe(2);
  });

  it('returns empty array when name does not exist', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'GET',
      url: '/prompts/name/nonexistent/versions',
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ total: number }>().total).toBe(0);
  });
});

describe('POST /prompts', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  const VALID_BODY = {
    name: 'hook-bs-BA-v1',
    language: 'bs-BA',
    phase: 'hook',
    content: 'Zdravo, zovem se Goran...',
  };

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'POST', url: '/prompts', body: VALID_BODY });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for viewer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/prompts',
      body: VALID_BODY,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates first version (version = 1)', async () => {
    // First query: MAX(version) returns null (no existing)
    queryMock.mockResolvedValueOnce({ rows: [{ max_version: null }], rowCount: 1 } as never);
    // Second query: INSERT
    queryMock.mockResolvedValueOnce({
      rows: [{ id: SAMPLE_PROMPT.id, version: 1 }],
      rowCount: 1,
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/prompts',
      body: VALID_BODY,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ version: number }>().version).toBe(1);
  });

  it('auto-increments version when name already exists', async () => {
    // MAX(version) returns 2
    queryMock.mockResolvedValueOnce({ rows: [{ max_version: 2 }], rowCount: 1 } as never);
    // INSERT with version 3
    queryMock.mockResolvedValueOnce({
      rows: [{ id: SAMPLE_PROMPT.id, version: 3 }],
      rowCount: 1,
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/prompts',
      body: VALID_BODY,
      headers: { authorization: managerToken() },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ version: number }>().version).toBe(3);
  });

  it('returns 400 for invalid phase', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/prompts',
      body: { ...VALID_BODY, phase: 'greeting' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for missing content', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/prompts',
      body: { name: 'test', language: 'bs-BA', phase: 'hook' }, // missing content
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /prompts/:id/active', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('activates a prompt', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: SAMPLE_PROMPT.id }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'PATCH',
      url: `/prompts/${SAMPLE_PROMPT.id}/active`,
      body: { is_active: true },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ success: boolean }>().success).toBe(true);
  });

  it('deactivates a prompt', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: SAMPLE_PROMPT.id }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'PATCH',
      url: `/prompts/${SAMPLE_PROMPT.id}/active`,
      body: { is_active: false },
      headers: { authorization: managerToken() },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 when is_active is missing from body', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/prompts/${SAMPLE_PROMPT.id}/active`,
      body: {},
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when prompt not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'PATCH',
      url: `/prompts/${SAMPLE_PROMPT.id}/active`,
      body: { is_active: true },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 for viewer', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/prompts/${SAMPLE_PROMPT.id}/active`,
      body: { is_active: true },
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(403);
  });
});
