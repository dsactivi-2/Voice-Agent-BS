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
  const { dispositionRoutes } = await import('../src/routes/dispositions.js');

  const fastify = Fastify({ logger: false, trustProxy: true });
  await fastify.register(cors, { origin: true });
  await fastify.register(helmet, { contentSecurityPolicy: false });
  await fastify.register(rateLimit, { global: false, max: 100, timeWindow: '1 minute' });
  await fastify.register(dispositionRoutes);
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
const DISPO_ID = '660e8400-e29b-41d4-a716-446655440002';

const SAMPLE_DISPO = {
  id: DISPO_ID,
  campaign_id: CAMPAIGN_ID,
  code: 'INTERESTED',
  label: 'Interested',
  is_success: true,
  is_dnc: false,
  retry_allowed: false,
  retry_after_hours: 0,
  sort_order: 10,
  created_at: '2024-01-01T00:00:00Z',
};

// ─── GET /campaigns/:campaignId/dispositions ──────────────────────────────────

describe('GET /campaigns/:campaignId/dispositions', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'GET', url: `/campaigns/${CAMPAIGN_ID}/dispositions` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for non-UUID campaign ID', async () => {
    const res = await app.inject({
      method: 'GET', url: '/campaigns/not-a-uuid/dispositions',
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns disposition list for authenticated user', async () => {
    queryMock.mockResolvedValueOnce({ rows: [SAMPLE_DISPO], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'GET', url: `/campaigns/${CAMPAIGN_ID}/dispositions`,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ dispositions: unknown[]; total: number }>();
    expect(body.dispositions).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it('returns empty list when no dispositions exist', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'GET', url: `/campaigns/${CAMPAIGN_ID}/dispositions`,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ total: number }>().total).toBe(0);
  });
});

// ─── POST /campaigns/:campaignId/dispositions ─────────────────────────────────

describe('POST /campaigns/:campaignId/dispositions', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  const validBody = { code: 'INTERESTED', label: 'Interested' };

  it('returns 401 without token', async () => {
    const res = await app.inject({
      method: 'POST', url: `/campaigns/${CAMPAIGN_ID}/dispositions`, payload: validBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for viewer role', async () => {
    const res = await app.inject({
      method: 'POST', url: `/campaigns/${CAMPAIGN_ID}/dispositions`, payload: validBody,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 for invalid code format (lowercase)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/campaigns/${CAMPAIGN_ID}/dispositions`,
      payload: { code: 'interested', label: 'Interested' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for missing label', async () => {
    const res = await app.inject({
      method: 'POST', url: `/campaigns/${CAMPAIGN_ID}/dispositions`,
      payload: { code: 'INTERESTED' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates disposition and returns 201', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: DISPO_ID }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'POST', url: `/campaigns/${CAMPAIGN_ID}/dispositions`,
      payload: validBody,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ dispositionId: string }>().dispositionId).toBe(DISPO_ID);
  });

  it('allows manager to create disposition', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: DISPO_ID }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'POST', url: `/campaigns/${CAMPAIGN_ID}/dispositions`,
      payload: { code: 'NO_ANSWER', label: 'No Answer' },
      headers: { authorization: managerToken() },
    });
    expect(res.statusCode).toBe(201);
  });

  it('returns 409 on duplicate code', async () => {
    queryMock.mockRejectedValueOnce(new Error('unique_dispo_code violation') as never);
    const res = await app.inject({
      method: 'POST', url: `/campaigns/${CAMPAIGN_ID}/dispositions`,
      payload: validBody,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('DUPLICATE_CODE');
  });
});

// ─── PUT /campaigns/:campaignId/dispositions/:dispositionId ───────────────────

describe('PUT /campaigns/:campaignId/dispositions/:dispositionId', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  const url = `/campaigns/${CAMPAIGN_ID}/dispositions/${DISPO_ID}`;

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'PUT', url, payload: { label: 'Updated' } });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for viewer role', async () => {
    const res = await app.inject({
      method: 'PUT', url, payload: { label: 'Updated' },
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 for empty body', async () => {
    const res = await app.inject({
      method: 'PUT', url, payload: {},
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('EMPTY_UPDATE');
  });

  it('returns 404 when disposition not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'PUT', url, payload: { label: 'Updated' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('updates label successfully', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: DISPO_ID }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'PUT', url, payload: { label: 'Very Interested' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ success: boolean }>().success).toBe(true);
  });

  it('cannot update the code field (it is omitted from schema)', async () => {
    // code is omitted from updateDispositionSchema — any code field in body is ignored
    queryMock.mockResolvedValueOnce({ rows: [{ id: DISPO_ID }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'PUT', url, payload: { label: 'New Label', code: 'CHANGED' },
      headers: { authorization: adminToken() },
    });
    // code is ignored, update proceeds with label only
    expect(res.statusCode).toBe(200);
  });
});

// ─── DELETE /campaigns/:campaignId/dispositions/:dispositionId ────────────────

describe('DELETE /campaigns/:campaignId/dispositions/:dispositionId', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  const url = `/campaigns/${CAMPAIGN_ID}/dispositions/${DISPO_ID}`;

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'DELETE', url });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for manager role', async () => {
    const res = await app.inject({
      method: 'DELETE', url,
      headers: { authorization: managerToken() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 when disposition not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'DELETE', url,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('deletes disposition successfully', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: DISPO_ID }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'DELETE', url,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ success: boolean }>().success).toBe(true);
  });

  it('returns 400 for non-UUID disposition ID', async () => {
    const res = await app.inject({
      method: 'DELETE', url: `/campaigns/${CAMPAIGN_ID}/dispositions/not-a-uuid`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });
});
