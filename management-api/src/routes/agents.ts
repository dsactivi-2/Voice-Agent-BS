import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod/v4';
import { query } from '../db/pool.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const LANGUAGES = ['bs-BA', 'sr-RS'] as const;
const LLM_MODELS = ['gpt-4o-mini', 'gpt-4o'] as const;

const promptsSchema = z.object({
  system: z.string().default(''),
  hook: z.string().default(''),
  qualify: z.string().default(''),
  pitch: z.string().default(''),
  objection: z.string().default(''),
  close: z.string().default(''),
  confirm: z.string().default(''),
});

const memoryConfigSchema = z.object({
  window_turns: z.number().int().min(1).max(20).default(4),
  summary_interval: z.number().int().min(1).max(20).default(5),
  cross_call_enabled: z.boolean().default(true),
});

const createAgentSchema = z.object({
  name: z.string().min(1).max(100),
  language: z.enum(LANGUAGES),
  tts_voice: z.string().min(1).max(200),
  llm_model: z.enum(LLM_MODELS).default('gpt-4o-mini'),
  temperature: z.number().min(0).max(2).default(0.7),
  prompts: promptsSchema.optional().default({
    system: '', hook: '', qualify: '', pitch: '', objection: '', close: '', confirm: '',
  }),
  memory_config: memoryConfigSchema.optional().default({
    window_turns: 4, summary_interval: 5, cross_call_enabled: true,
  }),
});

const updateAgentSchema = createAgentSchema.partial().extend({
  is_active: z.boolean().optional(),
});

const listQuerySchema = z.object({
  active: z.enum(['true', 'false']).optional(),
  language: z.enum(LANGUAGES).optional(),
});

const idParamSchema = z.object({
  id: z.string().uuid('Agent ID must be a valid UUID'),
});

// ─── DB row type ──────────────────────────────────────────────────────────────

interface AgentRow {
  id: string;
  name: string;
  language: string;
  tts_voice: string;
  llm_model: string;
  temperature: string;
  prompts: Record<string, string>;
  memory_config: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function listAgentsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = listQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid query parameters', code: 'INVALID_QUERY' });
    return;
  }

  const { active, language } = parsed.data;

  const conditions: string[] = [];
  const values: unknown[] = [];

  if (active !== undefined) {
    values.push(active === 'true');
    conditions.push(`is_active = $${values.length}`);
  }

  if (language !== undefined) {
    values.push(language);
    conditions.push(`language = $${values.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await query<AgentRow>(
      `SELECT id, name, language, tts_voice, llm_model, temperature,
              prompts, memory_config, is_active, created_at, updated_at
       FROM ai_agents ${where} ORDER BY name ASC`,
      values,
    );
    await reply.code(200).send({ agents: result.rows, total: result.rows.length });
  } catch (err) {
    logger.error({ err }, 'Failed to list agents');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function getAgentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = idParamSchema.safeParse(request.params);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid agent ID', code: 'INVALID_ID' });
    return;
  }

  try {
    const result = await query<AgentRow>(
      `SELECT id, name, language, tts_voice, llm_model, temperature,
              prompts, memory_config, is_active, created_at, updated_at
       FROM ai_agents WHERE id = $1`,
      [parsed.data.id],
    );

    if (result.rows.length === 0) {
      await reply.code(404).send({ error: 'Agent not found', code: 'NOT_FOUND' });
      return;
    }

    await reply.code(200).send({ agent: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to get agent');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function createAgentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = createAgentSchema.safeParse(request.body);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Validation failed', code: 'INVALID_BODY', details: parsed.error.issues });
    return;
  }

  const { name, language, tts_voice, llm_model, temperature, prompts, memory_config } = parsed.data;

  try {
    const result = await query<Pick<AgentRow, 'id'>>(
      `INSERT INTO ai_agents (name, language, tts_voice, llm_model, temperature, prompts, memory_config)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [name, language, tts_voice, llm_model, temperature, JSON.stringify(prompts), JSON.stringify(memory_config)],
    );

    logger.info({ agentId: result.rows[0]?.id, name }, 'Agent created');
    await reply.code(201).send({ agentId: result.rows[0]?.id });
  } catch (err) {
    logger.error({ err }, 'Failed to create agent');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function updateAgentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const idParsed = idParamSchema.safeParse(request.params);
  if (!idParsed.success) {
    await reply.code(400).send({ error: 'Invalid agent ID', code: 'INVALID_ID' });
    return;
  }

  const bodyParsed = updateAgentSchema.safeParse(request.body);
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
    language: fields.language,
    tts_voice: fields.tts_voice,
    llm_model: fields.llm_model,
    temperature: fields.temperature,
    is_active: fields.is_active,
    prompts: fields.prompts !== undefined ? JSON.stringify(fields.prompts) : undefined,
    memory_config: fields.memory_config !== undefined ? JSON.stringify(fields.memory_config) : undefined,
  };

  for (const [col, val] of Object.entries(fieldMap)) {
    if (val !== undefined) {
      values.push(val);
      setClauses.push(`${col} = $${values.length}`);
    }
  }

  values.push(idParsed.data.id);
  const idPlaceholder = `$${values.length}`;

  try {
    const result = await query<Pick<AgentRow, 'id'>>(
      `UPDATE ai_agents SET ${setClauses.join(', ')} WHERE id = ${idPlaceholder} RETURNING id`,
      values,
    );

    if (result.rows.length === 0) {
      await reply.code(404).send({ error: 'Agent not found', code: 'NOT_FOUND' });
      return;
    }

    logger.info({ agentId: idParsed.data.id }, 'Agent updated');
    await reply.code(200).send({ success: true });
  } catch (err) {
    logger.error({ err }, 'Failed to update agent');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function deleteAgentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = idParamSchema.safeParse(request.params);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid agent ID', code: 'INVALID_ID' });
    return;
  }

  try {
    // Soft delete: deactivate rather than destroy (agents may be referenced by campaigns)
    const result = await query<Pick<AgentRow, 'id'>>(
      `UPDATE ai_agents SET is_active = false WHERE id = $1 RETURNING id`,
      [parsed.data.id],
    );

    if (result.rows.length === 0) {
      await reply.code(404).send({ error: 'Agent not found', code: 'NOT_FOUND' });
      return;
    }

    logger.info({ agentId: parsed.data.id }, 'Agent deactivated');
    await reply.code(200).send({ success: true });
  } catch (err) {
    logger.error({ err }, 'Failed to deactivate agent');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export async function agentRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /agents — list (any authenticated user)
  fastify.get('/agents', { preHandler: authenticate }, listAgentsHandler);

  // GET /agents/:id — get one
  fastify.get('/agents/:id', { preHandler: authenticate }, getAgentHandler);

  // POST /agents — create (admin or manager only)
  fastify.post('/agents', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, createAgentHandler);

  // PUT /agents/:id — full update (admin or manager only)
  fastify.put('/agents/:id', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, updateAgentHandler);

  // DELETE /agents/:id — soft delete / deactivate (admin only)
  fastify.delete('/agents/:id', {
    preHandler: [authenticate, requireRole(['admin'])],
  }, deleteAgentHandler);
}
