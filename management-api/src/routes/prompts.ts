import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod/v4';
import { query } from '../db/pool.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const LANGUAGES = ['bs-BA', 'sr-RS', 'any'] as const;
const PHASES = ['system', 'hook', 'qualify', 'pitch', 'objection', 'close', 'confirm'] as const;

const createPromptSchema = z.object({
  name: z.string().min(1).max(200),
  language: z.enum(LANGUAGES),
  phase: z.enum(PHASES),
  content: z.string().min(1),
});

const listQuerySchema = z.object({
  language: z.enum(LANGUAGES).optional(),
  phase: z.enum(PHASES).optional(),
  active: z.enum(['true', 'false']).optional(),
});

const idParamSchema = z.object({
  id: z.string().uuid('Prompt ID must be a valid UUID'),
});

const nameParamSchema = z.object({
  name: z.string().min(1).max(200),
});

// ─── DB row type ──────────────────────────────────────────────────────────────

interface PromptRow {
  id: string;
  name: string;
  language: string;
  phase: string;
  content: string;
  version: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function listPromptsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = listQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid query parameters', code: 'INVALID_QUERY' });
    return;
  }

  const { language, phase, active } = parsed.data;

  const conditions: string[] = [];
  const values: unknown[] = [];

  if (language !== undefined) {
    values.push(language);
    conditions.push(`language = $${values.length}`);
  }

  if (phase !== undefined) {
    values.push(phase);
    conditions.push(`phase = $${values.length}`);
  }

  if (active !== undefined) {
    values.push(active === 'true');
    conditions.push(`is_active = $${values.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await query<PromptRow>(
      `SELECT id, name, language, phase, content, version, is_active, created_at, updated_at
       FROM prompts ${where} ORDER BY name ASC, version DESC`,
      values,
    );
    await reply.code(200).send({ prompts: result.rows, total: result.rows.length });
  } catch (err) {
    logger.error({ err }, 'Failed to list prompts');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function getPromptHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = idParamSchema.safeParse(request.params);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid prompt ID', code: 'INVALID_ID' });
    return;
  }

  try {
    const result = await query<PromptRow>(
      `SELECT id, name, language, phase, content, version, is_active, created_at, updated_at
       FROM prompts WHERE id = $1`,
      [parsed.data.id],
    );

    if (result.rows.length === 0) {
      await reply.code(404).send({ error: 'Prompt not found', code: 'NOT_FOUND' });
      return;
    }

    await reply.code(200).send({ prompt: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to get prompt');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function getPromptVersionsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = nameParamSchema.safeParse(request.params);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid prompt name', code: 'INVALID_NAME' });
    return;
  }

  try {
    const result = await query<PromptRow>(
      `SELECT id, name, language, phase, content, version, is_active, created_at, updated_at
       FROM prompts WHERE name = $1 ORDER BY version DESC`,
      [parsed.data.name],
    );

    await reply.code(200).send({ versions: result.rows, total: result.rows.length });
  } catch (err) {
    logger.error({ err }, 'Failed to get prompt versions');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function createPromptHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = createPromptSchema.safeParse(request.body);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Validation failed', code: 'INVALID_BODY', details: parsed.error.issues });
    return;
  }

  const { name, language, phase, content } = parsed.data;

  try {
    // Auto-increment version: find the highest existing version for this name
    const existing = await query<{ max_version: number | null }>(
      `SELECT MAX(version) AS max_version FROM prompts WHERE name = $1`,
      [name],
    );

    const nextVersion = (existing.rows[0]?.max_version ?? 0) + 1;

    const result = await query<Pick<PromptRow, 'id' | 'version'>>(
      `INSERT INTO prompts (name, language, phase, content, version)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, version`,
      [name, language, phase, content, nextVersion],
    );

    const created = result.rows[0];
    logger.info({ promptId: created?.id, name, version: created?.version }, 'Prompt created');
    await reply.code(201).send({ promptId: created?.id, version: created?.version });
  } catch (err) {
    logger.error({ err }, 'Failed to create prompt');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function togglePromptActiveHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const idParsed = idParamSchema.safeParse(request.params);
  if (!idParsed.success) {
    await reply.code(400).send({ error: 'Invalid prompt ID', code: 'INVALID_ID' });
    return;
  }

  const bodyParsed = z.object({ is_active: z.boolean() }).safeParse(request.body);
  if (!bodyParsed.success) {
    await reply.code(400).send({ error: 'Validation failed', code: 'INVALID_BODY' });
    return;
  }

  try {
    const result = await query<Pick<PromptRow, 'id'>>(
      `UPDATE prompts SET is_active = $1 WHERE id = $2 RETURNING id`,
      [bodyParsed.data.is_active, idParsed.data.id],
    );

    if (result.rows.length === 0) {
      await reply.code(404).send({ error: 'Prompt not found', code: 'NOT_FOUND' });
      return;
    }

    logger.info({ promptId: idParsed.data.id, is_active: bodyParsed.data.is_active }, 'Prompt active state updated');
    await reply.code(200).send({ success: true });
  } catch (err) {
    logger.error({ err }, 'Failed to update prompt active state');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export async function promptRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /prompts — list (any authenticated user)
  fastify.get('/prompts', { preHandler: authenticate }, listPromptsHandler);

  // GET /prompts/:id — get one
  fastify.get('/prompts/:id', { preHandler: authenticate }, getPromptHandler);

  // GET /prompts/name/:name/versions — all versions of a named prompt
  fastify.get('/prompts/name/:name/versions', { preHandler: authenticate }, getPromptVersionsHandler);

  // POST /prompts — create new version (admin or manager)
  fastify.post('/prompts', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, createPromptHandler);

  // PATCH /prompts/:id/active — activate / deactivate (admin or manager)
  fastify.patch('/prompts/:id/active', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, togglePromptActiveHandler);
}
