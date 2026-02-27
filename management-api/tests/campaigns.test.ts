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
  const { campaignRoutes } = await import('../src/routes/campaigns.js');

  const fastify = Fastify({ logger: false, trustProxy: true });
  await fastify.register(cors, { origin: true });
  await fastify.register(helmet, { contentSecurityPolicy: false });
  await fastify.register(rateLimit, { global: false, max: 100, timeWindow: '1 minute' });
  await fastify.register(campaignRoutes);
  await fastify.ready();
  return fastify;
}

function adminToken(): string {
  return `Bearer ${signAccessToken({ userId: 'u1', email: 'admin@test.com', role: 'admin' })}`;
}
function managerToken(): string {
  return `Bearer ${signAccessToken({ userId: 'u2', email: 'manager@test.com', role: 'manager' })}`;
}
function viewerToken(): string {
  return `Bearer ${signAccessToken({ userId: 'u3', email: 'viewer@test.com', role: 'viewer' })}`;
}

const CAMPAIGN_ID = '550e8400-e29b-41d4-a716-446655440001';

const SAMPLE_CAMPAIGN = {
  id: CAMPAIGN_ID,
  name: 'Q1 Outbound',
  status: 'draft',
  dialing_mode: 'ratio',
  dial_ratio: '1.0',
  agent_id: null,
  agent_name: null,
  kb_id: null,
  kb_name: null,
  phone_number_id: null,
  phone_number: null,
  timezone: 'Europe/Sarajevo',
  call_window_start: '09:00',
  call_window_end: '18:00',
  active_days: [1, 2, 3, 4, 5],
  max_retries: 3,
  retry_interval_hours: 24,
  notes: null,
  lead_count: '0',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

// ─── GET /campaigns ───────────────────────────────────────────────────────────

describe('GET /campaigns', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'GET', url: '/campaigns' });
    expect(res.statusCode).toBe(401);
  });

  it('returns campaign list for authenticated user', async () => {
    queryMock.mockResolvedValueOnce({ rows: [SAMPLE_CAMPAIGN], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'GET', url: '/campaigns',
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ campaigns: unknown[]; total: number }>();
    expect(body.campaigns).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it('filters by status query param', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'GET', url: '/campaigns?status=active',
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('status'),
      expect.arrayContaining(['active']),
    );
  });

  it('returns 400 for invalid status value', async () => {
    const res = await app.inject({
      method: 'GET', url: '/campaigns?status=invalid',
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── GET /campaigns/:id ───────────────────────────────────────────────────────

describe('GET /campaigns/:id', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'GET', url: `/campaigns/${CAMPAIGN_ID}` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for non-UUID id', async () => {
    const res = await app.inject({
      method: 'GET', url: '/campaigns/not-a-uuid',
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when campaign does not exist', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'GET', url: `/campaigns/${CAMPAIGN_ID}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns campaign data on success', async () => {
    queryMock.mockResolvedValueOnce({ rows: [SAMPLE_CAMPAIGN], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'GET', url: `/campaigns/${CAMPAIGN_ID}`,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ campaign: { id: string } }>().campaign.id).toBe(CAMPAIGN_ID);
  });
});

// ─── POST /campaigns ──────────────────────────────────────────────────────────

describe('POST /campaigns', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  const validBody = { name: 'Test Campaign' };

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'POST', url: '/campaigns', payload: validBody });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for viewer role', async () => {
    const res = await app.inject({
      method: 'POST', url: '/campaigns', payload: validBody,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 for missing name', async () => {
    const res = await app.inject({
      method: 'POST', url: '/campaigns', payload: {},
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates campaign and returns 201 with campaignId', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: CAMPAIGN_ID }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'POST', url: '/campaigns', payload: validBody,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ campaignId: string }>().campaignId).toBe(CAMPAIGN_ID);
  });

  it('allows manager role to create campaign', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: CAMPAIGN_ID }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'POST', url: '/campaigns', payload: { name: 'Manager Campaign' },
      headers: { authorization: managerToken() },
    });
    expect(res.statusCode).toBe(201);
  });
});

// ─── PUT /campaigns/:id ───────────────────────────────────────────────────────

describe('PUT /campaigns/:id', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'PUT', url: `/campaigns/${CAMPAIGN_ID}`, payload: { name: 'X' } });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for viewer role', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/campaigns/${CAMPAIGN_ID}`, payload: { name: 'X' },
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 for empty body', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/campaigns/${CAMPAIGN_ID}`, payload: {},
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('EMPTY_UPDATE');
  });

  it('returns 409 when campaign is active', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'active' }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'PUT', url: `/campaigns/${CAMPAIGN_ID}`, payload: { name: 'New Name' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('CAMPAIGN_LOCKED');
  });

  it('returns 404 when campaign not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'PUT', url: `/campaigns/${CAMPAIGN_ID}`, payload: { name: 'New Name' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('updates campaign name successfully', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'draft' }], rowCount: 1 } as never);
    queryMock.mockResolvedValueOnce({ rows: [{ id: CAMPAIGN_ID }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'PUT', url: `/campaigns/${CAMPAIGN_ID}`, payload: { name: 'Renamed' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ success: boolean }>().success).toBe(true);
  });
});

// ─── PATCH /campaigns/:id/status ─────────────────────────────────────────────

describe('PATCH /campaigns/:id/status', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/campaigns/${CAMPAIGN_ID}/status`, payload: { status: 'active' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 409 for invalid transition (draft → stopped)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'draft' }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'PATCH', url: `/campaigns/${CAMPAIGN_ID}/status`,
      payload: { status: 'stopped' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('INVALID_TRANSITION');
  });

  it('transitions draft → active successfully', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'draft' }], rowCount: 1 } as never);
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'PATCH', url: `/campaigns/${CAMPAIGN_ID}/status`,
      payload: { status: 'active' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('active');
  });

  it('returns 404 for non-existent campaign', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'PATCH', url: `/campaigns/${CAMPAIGN_ID}/status`,
      payload: { status: 'active' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for invalid status value', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/campaigns/${CAMPAIGN_ID}/status`,
      payload: { status: 'invalid' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── DELETE /campaigns/:id ────────────────────────────────────────────────────

describe('DELETE /campaigns/:id', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/campaigns/${CAMPAIGN_ID}` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for manager role', async () => {
    const res = await app.inject({
      method: 'DELETE', url: `/campaigns/${CAMPAIGN_ID}`,
      headers: { authorization: managerToken() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 409 when campaign is active', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'active' }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'DELETE', url: `/campaigns/${CAMPAIGN_ID}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('CAMPAIGN_RUNNING');
  });

  it('deletes a stopped campaign successfully', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'stopped' }], rowCount: 1 } as never);
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'DELETE', url: `/campaigns/${CAMPAIGN_ID}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ success: boolean }>().success).toBe(true);
  });

  it('returns 404 when campaign not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'DELETE', url: `/campaigns/${CAMPAIGN_ID}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });
});
