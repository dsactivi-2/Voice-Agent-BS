import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod/v4';
import { query } from '../db/pool.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const createDispositionSchema = z.object({
  code: z.string().min(1).max(50).regex(/^[A-Z0-9_]+$/, 'Code must be uppercase letters, digits, or underscores'),
  label: z.string().min(1).max(200),
  is_success: z.boolean().default(false),
  is_dnc: z.boolean().default(false),
  retry_allowed: z.boolean().default(true),
  retry_after_hours: z.number().int().min(0).max(720).default(24),
  sort_order: z.number().int().min(0).max(9999).default(0),
});

// Update schema has no defaults — all fields optional, empty body is rejected
const updateDispositionSchema = z.object({
  label: z.string().min(1).max(200),
  is_success: z.boolean(),
  is_dnc: z.boolean(),
  retry_allowed: z.boolean(),
  retry_after_hours: z.number().int().min(0).max(720),
  sort_order: z.number().int().min(0).max(9999),
}).partial();

const campaignIdParam = z.object({
  campaignId: z.string().uuid(),
});

const dispositionIdParam = z.object({
  campaignId: z.string().uuid(),
  dispositionId: z.string().uuid(),
});

// ─── DB row type ─────────────────────────────────────────────────────────────

interface DispositionRow {
  id: string;
  campaign_id: string;
  code: string;
  label: string;
  is_success: boolean;
  is_dnc: boolean;
  retry_allowed: boolean;
  retry_after_hours: number;
  sort_order: number;
  created_at: string;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function listDispositionsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = campaignIdParam.safeParse(request.params);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid campaign ID', code: 'INVALID_ID' });
    return;
  }

  try {
    const result = await query<DispositionRow>(
      `SELECT id, campaign_id, code, label, is_success, is_dnc,
              retry_allowed, retry_after_hours, sort_order, created_at
       FROM dispositions WHERE campaign_id = $1
       ORDER BY sort_order ASC, code ASC`,
      [parsed.data.campaignId],
    );
    await reply.code(200).send({ dispositions: result.rows, total: result.rows.length });
  } catch (err) {
    logger.error({ err }, 'Failed to list dispositions');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function createDispositionHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const idParsed = campaignIdParam.safeParse(request.params);
  if (!idParsed.success) {
    await reply.code(400).send({ error: 'Invalid campaign ID', code: 'INVALID_ID' });
    return;
  }

  const bodyParsed = createDispositionSchema.safeParse(request.body);
  if (!bodyParsed.success) {
    await reply.code(400).send({ error: 'Validation failed', code: 'INVALID_BODY', details: bodyParsed.error.issues });
    return;
  }

  const { code, label, is_success, is_dnc, retry_allowed, retry_after_hours, sort_order } = bodyParsed.data;
  const campaignId = idParsed.data.campaignId;

  try {
    const result = await query<{ id: string }>(
      `INSERT INTO dispositions (campaign_id, code, label, is_success, is_dnc, retry_allowed, retry_after_hours, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [campaignId, code, label, is_success, is_dnc, retry_allowed, retry_after_hours, sort_order],
    );

    logger.info({ campaignId, code, dispositionId: result.rows[0]?.id }, 'Disposition created');
    await reply.code(201).send({ dispositionId: result.rows[0]?.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('unique_dispo_code') || msg.includes('unique constraint')) {
      await reply.code(409).send({
        error: `Disposition code '${code}' already exists in this campaign`,
        code: 'DUPLICATE_CODE',
      });
      return;
    }
    logger.error({ err }, 'Failed to create disposition');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function updateDispositionHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const idParsed = dispositionIdParam.safeParse(request.params);
  if (!idParsed.success) {
    await reply.code(400).send({ error: 'Invalid ID', code: 'INVALID_ID' });
    return;
  }

  const bodyParsed = updateDispositionSchema.safeParse(request.body);
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
    label: fields.label,
    is_success: fields.is_success,
    is_dnc: fields.is_dnc,
    retry_allowed: fields.retry_allowed,
    retry_after_hours: fields.retry_after_hours,
    sort_order: fields.sort_order,
  };

  for (const [col, val] of Object.entries(fieldMap)) {
    if (val !== undefined) {
      values.push(val);
      setClauses.push(`${col} = $${values.length}`);
    }
  }

  values.push(idParsed.data.dispositionId);
  values.push(idParsed.data.campaignId);

  try {
    const result = await query<{ id: string }>(
      `UPDATE dispositions SET ${setClauses.join(', ')}
       WHERE id = $${values.length - 1} AND campaign_id = $${values.length}
       RETURNING id`,
      values,
    );

    if (result.rows.length === 0) {
      await reply.code(404).send({ error: 'Disposition not found', code: 'NOT_FOUND' });
      return;
    }

    await reply.code(200).send({ success: true });
  } catch (err) {
    logger.error({ err }, 'Failed to update disposition');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function deleteDispositionHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = dispositionIdParam.safeParse(request.params);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid ID', code: 'INVALID_ID' });
    return;
  }

  try {
    const result = await query<{ id: string }>(
      'DELETE FROM dispositions WHERE id = $1 AND campaign_id = $2 RETURNING id',
      [parsed.data.dispositionId, parsed.data.campaignId],
    );

    if (result.rows.length === 0) {
      await reply.code(404).send({ error: 'Disposition not found', code: 'NOT_FOUND' });
      return;
    }

    logger.info({ ...parsed.data }, 'Disposition deleted');
    await reply.code(200).send({ success: true });
  } catch (err) {
    logger.error({ err }, 'Failed to delete disposition');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export async function dispositionRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/campaigns/:campaignId/dispositions',
    { preHandler: authenticate },
    listDispositionsHandler,
  );

  fastify.post('/campaigns/:campaignId/dispositions', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, createDispositionHandler);

  fastify.put('/campaigns/:campaignId/dispositions/:dispositionId', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, updateDispositionHandler);

  fastify.delete('/campaigns/:campaignId/dispositions/:dispositionId', {
    preHandler: [authenticate, requireRole(['admin'])],
  }, deleteDispositionHandler);
}
