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
  const { leadRoutes } = await import('../src/routes/leads.js');

  const fastify = Fastify({ logger: false, trustProxy: true });
  await fastify.register(cors, { origin: true });
  await fastify.register(helmet, { contentSecurityPolicy: false });
  await fastify.register(rateLimit, { global: false, max: 100, timeWindow: '1 minute' });
  await fastify.register(leadRoutes);
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
const LIST_ID = '660e8400-e29b-41d4-a716-446655440002';
const LEAD_ID = '770e8400-e29b-41d4-a716-446655440003';
const DNC_ID = '880e8400-e29b-41d4-a716-446655440004';

const SAMPLE_LIST = {
  id: LIST_ID,
  campaign_id: CAMPAIGN_ID,
  name: 'January Import',
  filename: 'jan.csv',
  total_count: 100,
  processed_count: 98,
  created_at: '2024-01-01T00:00:00Z',
};

const SAMPLE_LEAD = {
  id: LEAD_ID,
  list_id: LIST_ID,
  campaign_id: CAMPAIGN_ID,
  phone_primary: '+38761000001',
  phone_alt1: null,
  first_name: 'Marko',
  last_name: 'Markovic',
  email: null,
  company: null,
  status: 'new',
  disposition_code: null,
  retry_count: 0,
  last_called_at: null,
  notes: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

// ─── GET /campaigns/:campaignId/lists ─────────────────────────────────────────

describe('GET /campaigns/:campaignId/lists', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'GET', url: `/campaigns/${CAMPAIGN_ID}/lists` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for non-UUID campaign ID', async () => {
    const res = await app.inject({
      method: 'GET', url: '/campaigns/bad-id/lists',
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns list of lead lists', async () => {
    queryMock.mockResolvedValueOnce({ rows: [SAMPLE_LIST], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'GET', url: `/campaigns/${CAMPAIGN_ID}/lists`,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ lists: unknown[]; total: number }>().total).toBe(1);
  });
});

// ─── GET /campaigns/:campaignId/lists/:listId ─────────────────────────────────

describe('GET /campaigns/:campaignId/lists/:listId', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'GET', url: `/campaigns/${CAMPAIGN_ID}/lists/${LIST_ID}` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when list not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'GET', url: `/campaigns/${CAMPAIGN_ID}/lists/${LIST_ID}`,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns list data on success', async () => {
    queryMock.mockResolvedValueOnce({ rows: [SAMPLE_LIST], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'GET', url: `/campaigns/${CAMPAIGN_ID}/lists/${LIST_ID}`,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ list: { id: string } }>().list.id).toBe(LIST_ID);
  });
});

// ─── GET /campaigns/:campaignId/lists/:listId/leads ──────────────────────────

describe('GET /campaigns/:campaignId/lists/:listId/leads', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({
      method: 'GET', url: `/campaigns/${CAMPAIGN_ID}/lists/${LIST_ID}/leads`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns paginated leads', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '5' }], rowCount: 1 } as never);
    queryMock.mockResolvedValueOnce({ rows: [SAMPLE_LEAD], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'GET', url: `/campaigns/${CAMPAIGN_ID}/lists/${LIST_ID}/leads`,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ leads: unknown[]; total: number; page: number; pageSize: number }>();
    expect(body.leads).toHaveLength(1);
    expect(body.total).toBe(5);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
  });

  it('accepts status filter', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 } as never);
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'GET', url: `/campaigns/${CAMPAIGN_ID}/lists/${LIST_ID}/leads?status=new`,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('COUNT'),
      expect.arrayContaining(['new']),
    );
  });

  it('returns 400 for invalid status filter', async () => {
    const res = await app.inject({
      method: 'GET', url: `/campaigns/${CAMPAIGN_ID}/lists/${LIST_ID}/leads?status=bogus`,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts pagination params', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '10' }], rowCount: 1 } as never);
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'GET', url: `/campaigns/${CAMPAIGN_ID}/lists/${LIST_ID}/leads?page=2&pageSize=5`,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ page: number; pageSize: number }>();
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(5);
  });
});

// ─── DELETE /campaigns/:campaignId/lists/:listId ──────────────────────────────

describe('DELETE /campaigns/:campaignId/lists/:listId', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/campaigns/${CAMPAIGN_ID}/lists/${LIST_ID}` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for viewer role', async () => {
    const res = await app.inject({
      method: 'DELETE', url: `/campaigns/${CAMPAIGN_ID}/lists/${LIST_ID}`,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 when list not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'DELETE', url: `/campaigns/${CAMPAIGN_ID}/lists/${LIST_ID}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('deletes list successfully', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: LIST_ID }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'DELETE', url: `/campaigns/${CAMPAIGN_ID}/lists/${LIST_ID}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ success: boolean }>().success).toBe(true);
  });
});

// ─── PATCH /leads/:leadId/disposition ────────────────────────────────────────

describe('PATCH /leads/:leadId/disposition', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/leads/${LEAD_ID}/disposition`,
      payload: { disposition_code: 'INTERESTED' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for viewer role', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/leads/${LEAD_ID}/disposition`,
      payload: { disposition_code: 'INTERESTED' },
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 for invalid lead ID', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/leads/not-a-uuid/disposition',
      payload: { disposition_code: 'INTERESTED' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for missing disposition_code', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/leads/${LEAD_ID}/disposition`,
      payload: {},
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 422 when disposition code not found in campaign', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'PATCH', url: `/leads/${LEAD_ID}/disposition`,
      payload: { disposition_code: 'UNKNOWN' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ code: string }>().code).toBe('INVALID_DISPOSITION');
  });

  it('sets non-DNC disposition to disposed status', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ is_dnc: false, campaign_id: CAMPAIGN_ID }], rowCount: 1 } as never);
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'PATCH', url: `/leads/${LEAD_ID}/disposition`,
      payload: { disposition_code: 'INTERESTED' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('disposed');
  });

  it('sets DNC disposition, updates lead to dnc and adds to DNC registry', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ is_dnc: true, campaign_id: CAMPAIGN_ID }], rowCount: 1 } as never);
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE leads
    queryMock.mockResolvedValueOnce({ rows: [{ phone_primary: '+38761000001' }], rowCount: 1 } as never); // SELECT phone
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // INSERT dnc
    const res = await app.inject({
      method: 'PATCH', url: `/leads/${LEAD_ID}/disposition`,
      payload: { disposition_code: 'DO_NOT_CALL' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('dnc');
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('dnc_numbers'),
      expect.any(Array),
    );
  });
});

// ─── GET /dnc ─────────────────────────────────────────────────────────────────

describe('GET /dnc', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'GET', url: '/dnc' });
    expect(res.statusCode).toBe(401);
  });

  it('returns paginated DNC list', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 } as never);
    queryMock.mockResolvedValueOnce({
      rows: [{ id: DNC_ID, phone: '+38761000001', reason: null, source: 'manual', added_by: null, added_at: '2024-01-01' }],
      rowCount: 1,
    } as never);
    const res = await app.inject({
      method: 'GET', url: '/dnc',
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ dnc: unknown[]; total: number }>();
    expect(body.total).toBe(2);
    expect(body.dnc).toHaveLength(1);
  });

  it('accepts search filter', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'GET', url: '/dnc?search=061',
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('ILIKE'),
      expect.arrayContaining(['%061%']),
    );
  });
});

// ─── POST /dnc ────────────────────────────────────────────────────────────────

describe('POST /dnc', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'POST', url: '/dnc', payload: { phone: '+38761000001' } });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for viewer role', async () => {
    const res = await app.inject({
      method: 'POST', url: '/dnc', payload: { phone: '+38761000001' },
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 for missing phone', async () => {
    const res = await app.inject({
      method: 'POST', url: '/dnc', payload: {},
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('adds a phone to DNC and returns 201', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: DNC_ID }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'POST', url: '/dnc',
      payload: { phone: '+387 61 000 001', reason: 'Customer request' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ dncId: string; phone: string }>();
    expect(body.phone).toBe('+38761000001'); // normalized
    expect(body.dncId).toBe(DNC_ID);
  });

  it('allows manager to add DNC number', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: DNC_ID }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'POST', url: '/dnc',
      payload: { phone: '062000001' },
      headers: { authorization: managerToken() },
    });
    expect(res.statusCode).toBe(201);
  });
});

// ─── DELETE /dnc/:id ──────────────────────────────────────────────────────────

describe('DELETE /dnc/:id', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/dnc/${DNC_ID}` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for manager role', async () => {
    const res = await app.inject({
      method: 'DELETE', url: `/dnc/${DNC_ID}`,
      headers: { authorization: managerToken() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 when DNC entry not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'DELETE', url: `/dnc/${DNC_ID}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('deletes DNC entry successfully', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: DNC_ID }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'DELETE', url: `/dnc/${DNC_ID}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ success: boolean }>().success).toBe(true);
  });
});

// ─── POST /dnc/check ──────────────────────────────────────────────────────────

describe('POST /dnc/check', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'POST', url: '/dnc/check', payload: { phone: '061111111' } });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for missing phone', async () => {
    const res = await app.inject({
      method: 'POST', url: '/dnc/check', payload: {},
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns is_dnc: false for non-DNC number', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'POST', url: '/dnc/check',
      payload: { phone: '061111111' },
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ is_dnc: boolean }>().is_dnc).toBe(false);
  });

  it('returns is_dnc: true with reason for DNC number', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: DNC_ID, reason: 'Customer request' }],
      rowCount: 1,
    } as never);
    const res = await app.inject({
      method: 'POST', url: '/dnc/check',
      payload: { phone: '+387 61 111 111' },
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ is_dnc: boolean; phone: string; reason: string }>();
    expect(body.is_dnc).toBe(true);
    expect(body.phone).toBe('+38761111111'); // normalized
    expect(body.reason).toBe('Customer request');
  });

  it('normalizes phone before checking', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await app.inject({
      method: 'POST', url: '/dnc/check',
      payload: { phone: '+387 61 000 001' },
      headers: { authorization: viewerToken() },
    });
    expect(queryMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['+38761000001']),
    );
  });
});

// ─── Auth: POST /campaigns/:id/lists/preview ──────────────────────────────────

describe('POST /campaigns/:campaignId/lists/preview — auth checks', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'POST', url: `/campaigns/${CAMPAIGN_ID}/lists/preview` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for viewer role', async () => {
    const res = await app.inject({
      method: 'POST', url: `/campaigns/${CAMPAIGN_ID}/lists/preview`,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── Auth: POST /campaigns/:id/lists/import ───────────────────────────────────

describe('POST /campaigns/:campaignId/lists/import — auth checks', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'POST', url: `/campaigns/${CAMPAIGN_ID}/lists/import` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for viewer role', async () => {
    const res = await app.inject({
      method: 'POST', url: `/campaigns/${CAMPAIGN_ID}/lists/import`,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(403);
  });
});
