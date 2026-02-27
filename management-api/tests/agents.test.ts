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
  const { agentRoutes } = await import('../src/routes/agents.js');

  const fastify = Fastify({ logger: false, trustProxy: true });
  await fastify.register(cors, { origin: true });
  await fastify.register(helmet, { contentSecurityPolicy: false });
  await fastify.register(rateLimit, { global: false, max: 100, timeWindow: '1 minute' });
  await fastify.register(agentRoutes);
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

const SAMPLE_AGENT = {
  id: '550e8400-e29b-41d4-a716-446655440001',
  name: 'Goran',
  language: 'bs-BA',
  tts_voice: 'bs-BA-GoranNeural',
  llm_model: 'gpt-4o-mini',
  temperature: '0.70',
  prompts: { system: 'Ti si Goran', hook: '', qualify: '', pitch: '', objection: '', close: '', confirm: '' },
  memory_config: { window_turns: 4, summary_interval: 5, cross_call_enabled: true },
  is_active: true,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /agents', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'GET', url: '/agents' });
    expect(res.statusCode).toBe(401);
  });

  it('returns agent list for authenticated user', async () => {
    queryMock.mockResolvedValueOnce({ rows: [SAMPLE_AGENT], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'GET',
      url: '/agents',
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ agents: typeof SAMPLE_AGENT[]; total: number }>();
    expect(body.total).toBe(1);
    expect(body.agents[0]?.name).toBe('Goran');
  });

  it('filters by active=true', async () => {
    queryMock.mockResolvedValueOnce({ rows: [SAMPLE_AGENT], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'GET',
      url: '/agents?active=true',
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
  });

  it('filters by language', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'GET',
      url: '/agents?language=sr-RS',
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ total: number }>().total).toBe(0);
  });

  it('returns 400 for invalid language filter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/agents?language=en-US',
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /agents/:id', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 404 when agent does not exist', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'GET',
      url: `/agents/${SAMPLE_AGENT.id}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns agent when found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [SAMPLE_AGENT], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'GET',
      url: `/agents/${SAMPLE_AGENT.id}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ agent: typeof SAMPLE_AGENT }>().agent.name).toBe('Goran');
  });

  it('returns 400 for non-UUID id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/agents/not-a-uuid',
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /agents', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  const VALID_BODY = {
    name: 'TestAgent',
    language: 'bs-BA',
    tts_voice: 'bs-BA-GoranNeural',
  };

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'POST', url: '/agents', body: VALID_BODY });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for viewer role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      body: VALID_BODY,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates agent for admin', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: SAMPLE_AGENT.id }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      body: VALID_BODY,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ agentId: string }>().agentId).toBe(SAMPLE_AGENT.id);
  });

  it('creates agent for manager', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: SAMPLE_AGENT.id }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      body: VALID_BODY,
      headers: { authorization: managerToken() },
    });
    expect(res.statusCode).toBe(201);
  });

  it('returns 400 for invalid language', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      body: { ...VALID_BODY, language: 'en-US' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for missing required field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      body: { name: 'Test' }, // missing language + tts_voice
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /agents/:id', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('updates agent for admin', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: SAMPLE_AGENT.id }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${SAMPLE_AGENT.id}`,
      body: { name: 'GoranV2', temperature: 0.5 },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 when agent not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${SAMPLE_AGENT.id}`,
      body: { name: 'Updated' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 for viewer', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${SAMPLE_AGENT.id}`,
      body: { name: 'Updated' },
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /agents/:id', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('soft-deletes agent for admin', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: SAMPLE_AGENT.id }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${SAMPLE_AGENT.id}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ success: boolean }>().success).toBe(true);
  });

  it('returns 403 for manager (admin only)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${SAMPLE_AGENT.id}`,
      headers: { authorization: managerToken() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 when agent not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${SAMPLE_AGENT.id}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });
});
