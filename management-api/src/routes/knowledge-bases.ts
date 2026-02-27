import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod/v4';
// pdf-parse@1.x runs a self-test on its index.js at import time which
// requires a local test PDF file. Importing from the lib subpath avoids this.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { query } from '../db/pool.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { chunkText, estimateTokenCount } from '../utils/chunker.js';
import { batchEmbeddings, generateEmbedding, toPostgresVector } from '../utils/embedder.js';

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const createKBSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  chunks_to_retrieve: z.number().int().min(1).max(10).default(3),
  similarity_threshold: z.number().min(0).max(1).default(0.6),
});

const updateKBSchema = createKBSchema.partial();

const idParamSchema = z.object({
  id: z.string().uuid('KB ID must be a valid UUID'),
});

const kbDocParamSchema = z.object({
  id: z.string().uuid(),
  docId: z.string().uuid(),
});

const addTextDocSchema = z.object({
  source_type: z.enum(['text', 'url']),
  content: z.string().min(1).optional(),         // required for source_type='text'
  source_url: z.string().url().optional(),       // required for source_type='url'
  sync_frequency: z.enum(['never', 'daily', 'weekly', 'monthly']).default('never'),
  filename: z.string().max(500).optional(),
});

const searchSchema = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(10).default(3),
  threshold: z.number().min(0).max(1).optional(),
});

// ─── DB row types ─────────────────────────────────────────────────────────────

interface KBRow {
  id: string;
  name: string;
  description: string | null;
  chunks_to_retrieve: number;
  similarity_threshold: string;
  last_synced_at: string | null;
  doc_count: string;
  created_at: string;
  updated_at: string;
}

interface DocRow {
  id: string;
  kb_id: string;
  source_type: string;
  source_url: string | null;
  filename: string | null;
  content: string;
  sync_frequency: string;
  status: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface ChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count: number | null;
  similarity: number;
}

// ─── Document processing ──────────────────────────────────────────────────────

/**
 * Fetches text from a URL. Strips HTML tags for basic content extraction.
 */
async function fetchUrlContent(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Activi-KnowledgeBase-Bot/1.0' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching URL: ${url}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  const raw = await res.text();

  if (contentType.includes('text/html')) {
    // Strip HTML tags and collapse whitespace
    return raw
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  return raw;
}

/**
 * Processes a document: chunks the text, generates embeddings, stores chunks.
 * Runs asynchronously after the document record is created.
 */
async function processDocument(
  docId: string,
  content: string,
  chunkSize: number,
  overlap: number,
): Promise<void> {
  try {
    await query('UPDATE kb_documents SET status = $1 WHERE id = $2', ['processing', docId]);

    const chunks = chunkText(content, chunkSize, overlap);
    if (chunks.length === 0) {
      await query(
        "UPDATE kb_documents SET status = $1, error_message = $2 WHERE id = $3",
        ['error', 'No content after chunking', docId],
      );
      return;
    }

    logger.info({ docId, chunkCount: chunks.length }, 'Generating embeddings');

    const embeddings = await batchEmbeddings(chunks);

    // Batch insert all chunks
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const embedding = embeddings[i]!;
      const tokenCount = estimateTokenCount(chunk);

      await query(
        `INSERT INTO kb_chunks (document_id, chunk_index, content, token_count, embedding)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (document_id, chunk_index) DO UPDATE
           SET content = EXCLUDED.content,
               token_count = EXCLUDED.token_count,
               embedding = EXCLUDED.embedding`,
        [docId, i, chunk, tokenCount, toPostgresVector(embedding)],
      );
    }

    await query(
      `UPDATE kb_documents SET status = $1 WHERE id = $2`,
      ['ready', docId],
    );

    await query(
      `UPDATE knowledge_bases SET last_synced_at = now()
       WHERE id = (SELECT kb_id FROM kb_documents WHERE id = $1)`,
      [docId],
    );

    logger.info({ docId, chunkCount: chunks.length }, 'Document processed successfully');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, docId }, 'Document processing failed');
    await query(
      "UPDATE kb_documents SET status = $1, error_message = $2 WHERE id = $3",
      ['error', message, docId],
    ).catch((e: unknown) => logger.error({ e }, 'Failed to update error status'));
  }
}

// ─── KB handlers ─────────────────────────────────────────────────────────────

async function listKBsHandler(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    const result = await query<KBRow>(
      `SELECT kb.id, kb.name, kb.description, kb.chunks_to_retrieve,
              kb.similarity_threshold, kb.last_synced_at, kb.created_at, kb.updated_at,
              COUNT(d.id) AS doc_count
       FROM knowledge_bases kb
       LEFT JOIN kb_documents d ON d.kb_id = kb.id
       GROUP BY kb.id
       ORDER BY kb.name ASC`,
      [],
    );
    await reply.code(200).send({ knowledge_bases: result.rows, total: result.rows.length });
  } catch (err) {
    logger.error({ err }, 'Failed to list knowledge bases');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function getKBHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = idParamSchema.safeParse(request.params);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid KB ID', code: 'INVALID_ID' });
    return;
  }

  try {
    const result = await query<KBRow>(
      `SELECT kb.id, kb.name, kb.description, kb.chunks_to_retrieve,
              kb.similarity_threshold, kb.last_synced_at, kb.created_at, kb.updated_at,
              COUNT(d.id) AS doc_count
       FROM knowledge_bases kb
       LEFT JOIN kb_documents d ON d.kb_id = kb.id
       WHERE kb.id = $1
       GROUP BY kb.id`,
      [parsed.data.id],
    );

    if (result.rows.length === 0) {
      await reply.code(404).send({ error: 'Knowledge base not found', code: 'NOT_FOUND' });
      return;
    }

    await reply.code(200).send({ knowledge_base: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to get knowledge base');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function createKBHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = createKBSchema.safeParse(request.body);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Validation failed', code: 'INVALID_BODY', details: parsed.error.issues });
    return;
  }

  const { name, description, chunks_to_retrieve, similarity_threshold } = parsed.data;

  try {
    const result = await query<{ id: string }>(
      `INSERT INTO knowledge_bases (name, description, chunks_to_retrieve, similarity_threshold)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, description ?? null, chunks_to_retrieve, similarity_threshold],
    );
    logger.info({ kbId: result.rows[0]?.id, name }, 'Knowledge base created');
    await reply.code(201).send({ kbId: result.rows[0]?.id });
  } catch (err) {
    logger.error({ err }, 'Failed to create knowledge base');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function updateKBHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const idParsed = idParamSchema.safeParse(request.params);
  if (!idParsed.success) {
    await reply.code(400).send({ error: 'Invalid KB ID', code: 'INVALID_ID' });
    return;
  }

  const bodyParsed = updateKBSchema.safeParse(request.body);
  if (!bodyParsed.success) {
    await reply.code(400).send({ error: 'Validation failed', code: 'INVALID_BODY', details: bodyParsed.error.issues });
    return;
  }

  const fields = bodyParsed.data;
  if (Object.keys(fields).length === 0) {
    await reply.code(400).send({ error: 'No fields to update', code: 'EMPTY_UPDATE' });
    return;
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];

  const fieldMap: Record<string, unknown> = {
    name: fields.name,
    description: fields.description,
    chunks_to_retrieve: fields.chunks_to_retrieve,
    similarity_threshold: fields.similarity_threshold,
  };

  for (const [col, val] of Object.entries(fieldMap)) {
    if (val !== undefined) {
      values.push(val);
      setClauses.push(`${col} = $${values.length}`);
    }
  }

  values.push(idParsed.data.id);

  try {
    const result = await query<{ id: string }>(
      `UPDATE knowledge_bases SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING id`,
      values,
    );

    if (result.rows.length === 0) {
      await reply.code(404).send({ error: 'Knowledge base not found', code: 'NOT_FOUND' });
      return;
    }

    await reply.code(200).send({ success: true });
  } catch (err) {
    logger.error({ err }, 'Failed to update knowledge base');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function deleteKBHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = idParamSchema.safeParse(request.params);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid KB ID', code: 'INVALID_ID' });
    return;
  }

  try {
    const result = await query<{ id: string }>(
      'DELETE FROM knowledge_bases WHERE id = $1 RETURNING id',
      [parsed.data.id],
    );

    if (result.rows.length === 0) {
      await reply.code(404).send({ error: 'Knowledge base not found', code: 'NOT_FOUND' });
      return;
    }

    logger.info({ kbId: parsed.data.id }, 'Knowledge base deleted');
    await reply.code(200).send({ success: true });
  } catch (err) {
    logger.error({ err }, 'Failed to delete knowledge base');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

// ─── Document handlers ────────────────────────────────────────────────────────

async function listDocumentsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = idParamSchema.safeParse(request.params);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid KB ID', code: 'INVALID_ID' });
    return;
  }

  try {
    const result = await query<DocRow>(
      `SELECT id, kb_id, source_type, source_url, filename, sync_frequency,
              status, error_message, created_at, updated_at
       FROM kb_documents WHERE kb_id = $1 ORDER BY created_at DESC`,
      [parsed.data.id],
    );
    await reply.code(200).send({ documents: result.rows, total: result.rows.length });
  } catch (err) {
    logger.error({ err }, 'Failed to list documents');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function addTextOrUrlDocumentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const idParsed = idParamSchema.safeParse(request.params);
  if (!idParsed.success) {
    await reply.code(400).send({ error: 'Invalid KB ID', code: 'INVALID_ID' });
    return;
  }

  const bodyParsed = addTextDocSchema.safeParse(request.body);
  if (!bodyParsed.success) {
    await reply.code(400).send({ error: 'Validation failed', code: 'INVALID_BODY', details: bodyParsed.error.issues });
    return;
  }

  const { source_type, content: rawContent, source_url, sync_frequency, filename } = bodyParsed.data;

  if (source_type === 'text' && !rawContent) {
    await reply.code(400).send({ error: 'content is required for source_type=text', code: 'MISSING_CONTENT' });
    return;
  }

  if (source_type === 'url' && !source_url) {
    await reply.code(400).send({ error: 'source_url is required for source_type=url', code: 'MISSING_URL' });
    return;
  }

  // Verify KB exists
  const kbCheck = await query<{ id: string }>(
    'SELECT id FROM knowledge_bases WHERE id = $1',
    [idParsed.data.id],
  );
  if (kbCheck.rows.length === 0) {
    await reply.code(404).send({ error: 'Knowledge base not found', code: 'NOT_FOUND' });
    return;
  }

  let content = rawContent ?? '';

  if (source_type === 'url') {
    try {
      content = await fetchUrlContent(source_url!);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await reply.code(422).send({ error: `Failed to fetch URL: ${message}`, code: 'URL_FETCH_ERROR' });
      return;
    }
  }

  try {
    const docResult = await query<{ id: string }>(
      `INSERT INTO kb_documents (kb_id, source_type, source_url, filename, content, sync_frequency)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [idParsed.data.id, source_type, source_url ?? null, filename ?? null, content, sync_frequency],
    );

    const docId = docResult.rows[0]!.id;
    logger.info({ kbId: idParsed.data.id, docId, source_type }, 'Document created, starting processing');

    // Fire-and-forget: process in background
    void processDocument(docId, content, 500, 50);

    await reply.code(202).send({ docId, status: 'processing' });
  } catch (err) {
    logger.error({ err }, 'Failed to create document');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function addPdfDocumentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const idParsed = idParamSchema.safeParse(request.params);
  if (!idParsed.success) {
    await reply.code(400).send({ error: 'Invalid KB ID', code: 'INVALID_ID' });
    return;
  }

  // Verify KB exists
  const kbCheck = await query<{ id: string }>(
    'SELECT id FROM knowledge_bases WHERE id = $1',
    [idParsed.data.id],
  );
  if (kbCheck.rows.length === 0) {
    await reply.code(404).send({ error: 'Knowledge base not found', code: 'NOT_FOUND' });
    return;
  }

  let content: string;
  let filename: string | null = null;

  try {
    const data = await request.file();
    if (!data) {
      await reply.code(400).send({ error: 'No file uploaded', code: 'MISSING_FILE' });
      return;
    }

    if (!data.mimetype.includes('pdf') && !data.filename.endsWith('.pdf')) {
      await reply.code(400).send({ error: 'Only PDF files are accepted', code: 'INVALID_FILE_TYPE' });
      return;
    }

    filename = data.filename;
    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk as Buffer);
    }
    const buffer = Buffer.concat(chunks);

    // 50 MB limit
    if (buffer.length > 50 * 1024 * 1024) {
      await reply.code(413).send({ error: 'PDF exceeds 50 MB limit', code: 'FILE_TOO_LARGE' });
      return;
    }

    const parsed = await pdfParse(buffer);
    content = parsed.text.trim();

    if (content.length === 0) {
      await reply.code(422).send({ error: 'Could not extract text from PDF', code: 'PDF_EMPTY' });
      return;
    }
  } catch (err) {
    if (reply.sent) return;
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'PDF extraction failed');
    await reply.code(422).send({ error: `PDF processing failed: ${message}`, code: 'PDF_ERROR' });
    return;
  }

  try {
    const docResult = await query<{ id: string }>(
      `INSERT INTO kb_documents (kb_id, source_type, filename, content, sync_frequency)
       VALUES ($1, 'pdf', $2, $3, 'never') RETURNING id`,
      [idParsed.data.id, filename, content],
    );

    const docId = docResult.rows[0]!.id;
    logger.info({ kbId: idParsed.data.id, docId, filename }, 'PDF document created, starting processing');

    void processDocument(docId, content, 500, 50);

    await reply.code(202).send({ docId, status: 'processing' });
  } catch (err) {
    logger.error({ err }, 'Failed to create PDF document record');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function deleteDocumentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = kbDocParamSchema.safeParse(request.params);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid ID', code: 'INVALID_ID' });
    return;
  }

  try {
    const result = await query<{ id: string }>(
      'DELETE FROM kb_documents WHERE id = $1 AND kb_id = $2 RETURNING id',
      [parsed.data.docId, parsed.data.id],
    );

    if (result.rows.length === 0) {
      await reply.code(404).send({ error: 'Document not found', code: 'NOT_FOUND' });
      return;
    }

    logger.info({ kbId: parsed.data.id, docId: parsed.data.docId }, 'Document deleted');
    await reply.code(200).send({ success: true });
  } catch (err) {
    logger.error({ err }, 'Failed to delete document');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

// ─── Search handler ───────────────────────────────────────────────────────────

async function searchKBHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const idParsed = idParamSchema.safeParse(request.params);
  if (!idParsed.success) {
    await reply.code(400).send({ error: 'Invalid KB ID', code: 'INVALID_ID' });
    return;
  }

  const bodyParsed = searchSchema.safeParse(request.body);
  if (!bodyParsed.success) {
    await reply.code(400).send({ error: 'Validation failed', code: 'INVALID_BODY', details: bodyParsed.error.issues });
    return;
  }

  const { query: searchQuery, limit, threshold } = bodyParsed.data;

  // Get KB settings for defaults
  let kbRow: { chunks_to_retrieve: number; similarity_threshold: string } | undefined;
  try {
    const kbResult = await query<{ chunks_to_retrieve: number; similarity_threshold: string }>(
      'SELECT chunks_to_retrieve, similarity_threshold FROM knowledge_bases WHERE id = $1',
      [idParsed.data.id],
    );
    kbRow = kbResult.rows[0];
    if (!kbRow) {
      await reply.code(404).send({ error: 'Knowledge base not found', code: 'NOT_FOUND' });
      return;
    }
  } catch (err) {
    logger.error({ err }, 'Failed to get KB settings');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
    return;
  }

  const effectiveLimit = limit ?? kbRow.chunks_to_retrieve;
  const effectiveThreshold = threshold ?? Number(kbRow.similarity_threshold);

  let queryEmbedding: number[];
  try {
    queryEmbedding = await generateEmbedding(searchQuery);
  } catch (err) {
    logger.error({ err }, 'Failed to generate query embedding');
    await reply.code(500).send({ error: 'Embedding generation failed', code: 'EMBEDDING_ERROR' });
    return;
  }

  try {
    const vectorLiteral = toPostgresVector(queryEmbedding);

    const result = await query<ChunkRow>(
      `SELECT
         c.id, c.document_id, c.chunk_index, c.content, c.token_count,
         1 - (c.embedding <=> $1::vector) AS similarity
       FROM kb_chunks c
       JOIN kb_documents d ON d.id = c.document_id
       WHERE d.kb_id = $2
         AND d.status = 'ready'
         AND 1 - (c.embedding <=> $1::vector) >= $3
       ORDER BY c.embedding <=> $1::vector
       LIMIT $4`,
      [vectorLiteral, idParsed.data.id, effectiveThreshold, effectiveLimit],
    );

    await reply.code(200).send({
      results: result.rows,
      total: result.rows.length,
      query: searchQuery,
    });
  } catch (err) {
    logger.error({ err }, 'Semantic search failed');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export async function knowledgeBaseRoutes(fastify: FastifyInstance): Promise<void> {
  // Register multipart support for PDF uploads
  await fastify.register(import('@fastify/multipart'), {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50 MB
      files: 1,
    },
  });

  // ── KB CRUD ───────────────────────────────────────────────────────────────

  // GET /knowledge-bases
  fastify.get('/knowledge-bases', { preHandler: authenticate }, listKBsHandler);

  // GET /knowledge-bases/:id
  fastify.get('/knowledge-bases/:id', { preHandler: authenticate }, getKBHandler);

  // POST /knowledge-bases (admin/manager)
  fastify.post('/knowledge-bases', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, createKBHandler);

  // PUT /knowledge-bases/:id (admin/manager)
  fastify.put('/knowledge-bases/:id', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, updateKBHandler);

  // DELETE /knowledge-bases/:id (admin only)
  fastify.delete('/knowledge-bases/:id', {
    preHandler: [authenticate, requireRole(['admin'])],
  }, deleteKBHandler);

  // ── Documents ─────────────────────────────────────────────────────────────

  // GET /knowledge-bases/:id/documents
  fastify.get('/knowledge-bases/:id/documents', {
    preHandler: authenticate,
  }, listDocumentsHandler);

  // POST /knowledge-bases/:id/documents (JSON: text or url)
  fastify.post('/knowledge-bases/:id/documents', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, addTextOrUrlDocumentHandler);

  // POST /knowledge-bases/:id/documents/pdf (multipart)
  fastify.post('/knowledge-bases/:id/documents/pdf', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, addPdfDocumentHandler);

  // DELETE /knowledge-bases/:id/documents/:docId
  fastify.delete('/knowledge-bases/:id/documents/:docId', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, deleteDocumentHandler);

  // ── Search ────────────────────────────────────────────────────────────────

  // POST /knowledge-bases/:id/search
  fastify.post('/knowledge-bases/:id/search', {
    preHandler: authenticate,
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
  }, searchKBHandler);
}
