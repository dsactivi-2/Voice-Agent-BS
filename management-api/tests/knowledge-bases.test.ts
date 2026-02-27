import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { signAccessToken } from '../src/auth/jwt.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock the embedder so tests don't call OpenAI
vi.mock('../src/utils/embedder.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
  batchEmbeddings: vi.fn().mockResolvedValue([new Array(1536).fill(0.1)]),
  toPostgresVector: vi.fn((v: number[]) => `[${v.join(',')}]`),
}));

import { query } from '../src/db/pool.js';
const queryMock = vi.mocked(query);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function buildApp(): Promise<FastifyInstance> {
  const { default: Fastify } = await import('fastify');
  const { default: cors } = await import('@fastify/cors');
  const { default: helmet } = await import('@fastify/helmet');
  const { default: rateLimit } = await import('@fastify/rate-limit');
  const { knowledgeBaseRoutes } = await import('../src/routes/knowledge-bases.js');

  const fastify = Fastify({ logger: false, trustProxy: true });
  await fastify.register(cors, { origin: true });
  await fastify.register(helmet, { contentSecurityPolicy: false });
  await fastify.register(rateLimit, { global: false, max: 100, timeWindow: '1 minute' });
  await fastify.register(knowledgeBaseRoutes);
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

const KB_ID = '770e8400-e29b-41d4-a716-446655440001';
const DOC_ID = '880e8400-e29b-41d4-a716-446655440001';

const SAMPLE_KB = {
  id: KB_ID,
  name: 'Activi FAQ',
  description: 'Frequently asked questions',
  chunks_to_retrieve: 3,
  similarity_threshold: '0.60',
  last_synced_at: null,
  doc_count: '2',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const SAMPLE_DOC = {
  id: DOC_ID,
  kb_id: KB_ID,
  source_type: 'text',
  source_url: null,
  filename: null,
  sync_frequency: 'never',
  status: 'ready',
  error_message: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

// ─── GET /knowledge-bases ─────────────────────────────────────────────────────

describe('GET /knowledge-bases', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'GET', url: '/knowledge-bases' });
    expect(res.statusCode).toBe(401);
  });

  it('returns list for viewer', async () => {
    queryMock.mockResolvedValueOnce({ rows: [SAMPLE_KB], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'GET', url: '/knowledge-bases',
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ total: number }>().total).toBe(1);
  });
});

// ─── GET /knowledge-bases/:id ─────────────────────────────────────────────────

describe('GET /knowledge-bases/:id', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns KB when found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [SAMPLE_KB], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'GET', url: `/knowledge-bases/${KB_ID}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ knowledge_base: typeof SAMPLE_KB }>().knowledge_base.name).toBe('Activi FAQ');
  });

  it('returns 404 when not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'GET', url: `/knowledge-bases/${KB_ID}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for non-UUID id', async () => {
    const res = await app.inject({
      method: 'GET', url: '/knowledge-bases/not-a-uuid',
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── POST /knowledge-bases ────────────────────────────────────────────────────

describe('POST /knowledge-bases', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  const VALID_BODY = { name: 'Moja KB', description: 'Opis', chunks_to_retrieve: 3 };

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'POST', url: '/knowledge-bases', body: VALID_BODY });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for viewer', async () => {
    const res = await app.inject({
      method: 'POST', url: '/knowledge-bases', body: VALID_BODY,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates KB for admin', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: KB_ID }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'POST', url: '/knowledge-bases', body: VALID_BODY,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ kbId: string }>().kbId).toBe(KB_ID);
  });

  it('creates KB for manager', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: KB_ID }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'POST', url: '/knowledge-bases', body: VALID_BODY,
      headers: { authorization: managerToken() },
    });
    expect(res.statusCode).toBe(201);
  });

  it('returns 400 for missing name', async () => {
    const res = await app.inject({
      method: 'POST', url: '/knowledge-bases', body: { description: 'no name' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when chunks_to_retrieve exceeds limit', async () => {
    const res = await app.inject({
      method: 'POST', url: '/knowledge-bases',
      body: { name: 'Test', chunks_to_retrieve: 50 },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── PUT /knowledge-bases/:id ─────────────────────────────────────────────────

describe('PUT /knowledge-bases/:id', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('updates KB for admin', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: KB_ID }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'PUT', url: `/knowledge-bases/${KB_ID}`,
      body: { name: 'Updated FAQ', similarity_threshold: 0.75 },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 when not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'PUT', url: `/knowledge-bases/${KB_ID}`,
      body: { name: 'Updated' },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 for viewer', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/knowledge-bases/${KB_ID}`,
      body: { name: 'Hack' },
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── DELETE /knowledge-bases/:id ─────────────────────────────────────────────

describe('DELETE /knowledge-bases/:id', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('deletes KB for admin', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: KB_ID }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'DELETE', url: `/knowledge-bases/${KB_ID}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ success: boolean }>().success).toBe(true);
  });

  it('returns 403 for manager (admin only)', async () => {
    const res = await app.inject({
      method: 'DELETE', url: `/knowledge-bases/${KB_ID}`,
      headers: { authorization: managerToken() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 when not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'DELETE', url: `/knowledge-bases/${KB_ID}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── GET /knowledge-bases/:id/documents ──────────────────────────────────────

describe('GET /knowledge-bases/:id/documents', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('returns documents list', async () => {
    queryMock.mockResolvedValueOnce({ rows: [SAMPLE_DOC], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'GET', url: `/knowledge-bases/${KB_ID}/documents`,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ total: number }>().total).toBe(1);
  });
});

// ─── POST /knowledge-bases/:id/documents (text) ───────────────────────────────

describe('POST /knowledge-bases/:id/documents (text)', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  const TEXT_BODY = {
    source_type: 'text',
    content: 'Ovo je sadržaj naše baze znanja o Activi platformi.',
  };

  it('returns 401 without token', async () => {
    const res = await app.inject({
      method: 'POST', url: `/knowledge-bases/${KB_ID}/documents`, body: TEXT_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for viewer', async () => {
    const res = await app.inject({
      method: 'POST', url: `/knowledge-bases/${KB_ID}/documents`, body: TEXT_BODY,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 202 and starts processing for admin', async () => {
    // 1. KB exists check
    queryMock.mockResolvedValueOnce({ rows: [{ id: KB_ID }], rowCount: 1 } as never);
    // 2. INSERT document
    queryMock.mockResolvedValueOnce({ rows: [{ id: DOC_ID }], rowCount: 1 } as never);

    const res = await app.inject({
      method: 'POST', url: `/knowledge-bases/${KB_ID}/documents`, body: TEXT_BODY,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json<{ docId: string; status: string }>().status).toBe('processing');
    expect(res.json<{ docId: string }>().docId).toBe(DOC_ID);
  });

  it('returns 404 when KB does not exist', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'POST', url: `/knowledge-bases/${KB_ID}/documents`, body: TEXT_BODY,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when source_type=text but content missing', async () => {
    // Route validates content before reaching DB — no mock needed
    const res = await app.inject({
      method: 'POST', url: `/knowledge-bases/${KB_ID}/documents`,
      body: { source_type: 'text' }, // missing content
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when source_type=url but source_url missing', async () => {
    // Route validates source_url before reaching DB — no mock needed
    const res = await app.inject({
      method: 'POST', url: `/knowledge-bases/${KB_ID}/documents`,
      body: { source_type: 'url' }, // missing source_url
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── DELETE /knowledge-bases/:id/documents/:docId ────────────────────────────

describe('DELETE /knowledge-bases/:id/documents/:docId', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('deletes document for manager', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: DOC_ID }], rowCount: 1 } as never);
    const res = await app.inject({
      method: 'DELETE', url: `/knowledge-bases/${KB_ID}/documents/${DOC_ID}`,
      headers: { authorization: managerToken() },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 when doc not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'DELETE', url: `/knowledge-bases/${KB_ID}/documents/${DOC_ID}`,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 for viewer', async () => {
    const res = await app.inject({
      method: 'DELETE', url: `/knowledge-bases/${KB_ID}/documents/${DOC_ID}`,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── POST /knowledge-bases/:id/search ────────────────────────────────────────

describe('POST /knowledge-bases/:id/search', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  const SEARCH_BODY = { query: 'Kakva je cijena paketa?', limit: 3 };

  const SAMPLE_CHUNK = {
    id: '990e8400-e29b-41d4-a716-446655440001',
    document_id: DOC_ID,
    chunk_index: 0,
    content: 'Cijena paketa je 49 KM mjesečno.',
    token_count: 10,
    similarity: 0.87,
  };

  it('returns 401 without token', async () => {
    const res = await app.inject({
      method: 'POST', url: `/knowledge-bases/${KB_ID}/search`, body: SEARCH_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns search results for viewer', async () => {
    // 1. KB settings
    queryMock.mockResolvedValueOnce({
      rows: [{ chunks_to_retrieve: 3, similarity_threshold: '0.60' }],
      rowCount: 1,
    } as never);
    // 2. Similarity search
    queryMock.mockResolvedValueOnce({ rows: [SAMPLE_CHUNK], rowCount: 1 } as never);

    const res = await app.inject({
      method: 'POST', url: `/knowledge-bases/${KB_ID}/search`, body: SEARCH_BODY,
      headers: { authorization: viewerToken() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ results: typeof SAMPLE_CHUNK[]; total: number; query: string }>();
    expect(body.total).toBe(1);
    expect(body.results[0]?.similarity).toBe(0.87);
    expect(body.query).toBe('Kakva je cijena paketa?');
  });

  it('returns 404 when KB not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await app.inject({
      method: 'POST', url: `/knowledge-bases/${KB_ID}/search`, body: SEARCH_BODY,
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when query is missing', async () => {
    const res = await app.inject({
      method: 'POST', url: `/knowledge-bases/${KB_ID}/search`, body: {},
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when limit exceeds max (10)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/knowledge-bases/${KB_ID}/search`,
      body: { query: 'test', limit: 20 },
      headers: { authorization: adminToken() },
    });
    expect(res.statusCode).toBe(400);
  });
});
