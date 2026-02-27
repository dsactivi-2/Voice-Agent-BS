import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod/v4';
import { query } from '../db/pool.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const STATUSES = ['draft', 'active', 'paused', 'stopped', 'completed'] as const;
const DIALING_MODES = ['manual', 'ratio', 'predictive'] as const;

const createCampaignSchema = z.object({
  name: z.string().min(1).max(200),
  dialing_mode: z.enum(DIALING_MODES).default('ratio'),
  dial_ratio: z.number().min(0.1).max(10).default(1.0),
  agent_id: z.string().uuid().optional(),
  kb_id: z.string().uuid().optional(),
  phone_number_id: z.string().uuid().optional(),
  timezone: z.string().max(100).default('Europe/Sarajevo'),
  call_window_start: z.string().regex(/^\d{2}:\d{2}$/, 'Format: HH:MM').default('09:00'),
  call_window_end: z.string().regex(/^\d{2}:\d{2}$/, 'Format: HH:MM').default('18:00'),
  active_days: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]),
  max_retries: z.number().int().min(0).max(10).default(3),
  retry_interval_hours: z.number().int().min(1).max(168).default(24),
  notes: z.string().max(5000).optional(),
});

// Update schema has no defaults — all fields optional, empty body is rejected
const updateCampaignSchema = z.object({
  name: z.string().min(1).max(200),
  dialing_mode: z.enum(DIALING_MODES),
  dial_ratio: z.number().min(0.1).max(10),
  agent_id: z.string().uuid().optional(),
  kb_id: z.string().uuid().optional(),
  phone_number_id: z.string().uuid().optional(),
  timezone: z.string().max(100),
  call_window_start: z.string().regex(/^\d{2}:\d{2}$/, 'Format: HH:MM'),
  call_window_end: z.string().regex(/^\d{2}:\d{2}$/, 'Format: HH:MM'),
  active_days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  max_retries: z.number().int().min(0).max(10),
  retry_interval_hours: z.number().int().min(1).max(168),
  notes: z.string().max(5000).optional(),
}).partial();

// Valid status transitions: from → allowed tos
const STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ['active'],
  active: ['paused', 'stopped'],
  paused: ['active', 'stopped'],
  stopped: ['draft'],
  completed: [],
};

const statusTransitionSchema = z.object({
  status: z.enum(STATUSES),
});

const listQuerySchema = z.object({
  status: z.enum(STATUSES).optional(),
});

const idParamSchema = z.object({
  id: z.string().uuid('Campaign ID must be a valid UUID'),
});

// ─── DB row types ─────────────────────────────────────────────────────────────

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  dialing_mode: string;
  dial_ratio: string;
  agent_id: string | null;
  agent_name: string | null;
  kb_id: string | null;
  kb_name: string | null;
  phone_number_id: string | null;
  phone_number: string | null;
  timezone: string;
  call_window_start: string;
  call_window_end: string;
  active_days: number[];
  max_retries: number;
  retry_interval_hours: number;
  notes: string | null;
  lead_count: string;
  created_at: string;
  updated_at: string;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function listCampaignsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = listQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid query', code: 'INVALID_QUERY' });
    return;
  }

  const { status } = parsed.data;
  const values: unknown[] = [];
  const where = status ? (values.push(status), `WHERE c.status = $${values.length}`) : '';

  try {
    const result = await query<CampaignRow>(
      `SELECT
         c.id, c.name, c.status, c.dialing_mode, c.dial_ratio,
         c.agent_id, a.name AS agent_name,
         c.kb_id, kb.name AS kb_name,
         c.phone_number_id, pn.number AS phone_number,
         c.timezone, c.call_window_start, c.call_window_end,
         c.active_days, c.max_retries, c.retry_interval_hours, c.notes,
         c.created_at, c.updated_at,
         COUNT(DISTINCT l.id) AS lead_count
       FROM campaigns c
       LEFT JOIN ai_agents a ON a.id = c.agent_id
       LEFT JOIN knowledge_bases kb ON kb.id = c.kb_id
       LEFT JOIN phone_numbers pn ON pn.id = c.phone_number_id
       LEFT JOIN leads l ON l.campaign_id = c.id
       ${where}
       GROUP BY c.id, a.name, kb.name, pn.number
       ORDER BY c.created_at DESC`,
      values,
    );
    await reply.code(200).send({ campaigns: result.rows, total: result.rows.length });
  } catch (err) {
    logger.error({ err }, 'Failed to list campaigns');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function getCampaignHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = idParamSchema.safeParse(request.params);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid campaign ID', code: 'INVALID_ID' });
    return;
  }

  try {
    const result = await query<CampaignRow>(
      `SELECT
         c.id, c.name, c.status, c.dialing_mode, c.dial_ratio,
         c.agent_id, a.name AS agent_name,
         c.kb_id, kb.name AS kb_name,
         c.phone_number_id, pn.number AS phone_number,
         c.timezone, c.call_window_start, c.call_window_end,
         c.active_days, c.max_retries, c.retry_interval_hours, c.notes,
         c.created_at, c.updated_at,
         COUNT(DISTINCT l.id) AS lead_count
       FROM campaigns c
       LEFT JOIN ai_agents a ON a.id = c.agent_id
       LEFT JOIN knowledge_bases kb ON kb.id = c.kb_id
       LEFT JOIN phone_numbers pn ON pn.id = c.phone_number_id
       LEFT JOIN leads l ON l.campaign_id = c.id
       WHERE c.id = $1
       GROUP BY c.id, a.name, kb.name, pn.number`,
      [parsed.data.id],
    );

    if (result.rows.length === 0) {
      await reply.code(404).send({ error: 'Campaign not found', code: 'NOT_FOUND' });
      return;
    }

    await reply.code(200).send({ campaign: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to get campaign');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function createCampaignHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = createCampaignSchema.safeParse(request.body);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Validation failed', code: 'INVALID_BODY', details: parsed.error.issues });
    return;
  }

  const {
    name, dialing_mode, dial_ratio, agent_id, kb_id, phone_number_id,
    timezone, call_window_start, call_window_end, active_days,
    max_retries, retry_interval_hours, notes,
  } = parsed.data;

  try {
    const result = await query<{ id: string }>(
      `INSERT INTO campaigns (
         name, dialing_mode, dial_ratio, agent_id, kb_id, phone_number_id,
         timezone, call_window_start, call_window_end, active_days,
         max_retries, retry_interval_hours, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        name, dialing_mode, dial_ratio, agent_id ?? null, kb_id ?? null, phone_number_id ?? null,
        timezone, call_window_start, call_window_end, active_days,
        max_retries, retry_interval_hours, notes ?? null,
      ],
    );

    logger.info({ campaignId: result.rows[0]?.id, name }, 'Campaign created');
    await reply.code(201).send({ campaignId: result.rows[0]?.id });
  } catch (err) {
    logger.error({ err }, 'Failed to create campaign');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function updateCampaignHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const idParsed = idParamSchema.safeParse(request.params);
  if (!idParsed.success) {
    await reply.code(400).send({ error: 'Invalid campaign ID', code: 'INVALID_ID' });
    return;
  }

  const bodyParsed = updateCampaignSchema.safeParse(request.body);
  if (!bodyParsed.success) {
    await reply.code(400).send({ error: 'Validation failed', code: 'INVALID_BODY', details: bodyParsed.error.issues });
    return;
  }

  const fields = bodyParsed.data;
  if (Object.keys(fields).length === 0) {
    await reply.code(400).send({ error: 'No fields to update', code: 'EMPTY_UPDATE' });
    return;
  }

  // Block updates on active campaigns for core settings
  const statusCheck = await query<{ status: string }>(
    'SELECT status FROM campaigns WHERE id = $1',
    [idParsed.data.id],
  );

  if (statusCheck.rows.length === 0) {
    await reply.code(404).send({ error: 'Campaign not found', code: 'NOT_FOUND' });
    return;
  }

  const currentStatus = statusCheck.rows[0]!.status;
  if (currentStatus === 'active' || currentStatus === 'completed') {
    await reply.code(409).send({
      error: `Cannot update campaign with status '${currentStatus}'`,
      code: 'CAMPAIGN_LOCKED',
    });
    return;
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];

  const fieldMap: Record<string, unknown> = {
    name: fields.name,
    dialing_mode: fields.dialing_mode,
    dial_ratio: fields.dial_ratio,
    agent_id: fields.agent_id,
    kb_id: fields.kb_id,
    phone_number_id: fields.phone_number_id,
    timezone: fields.timezone,
    call_window_start: fields.call_window_start,
    call_window_end: fields.call_window_end,
    active_days: fields.active_days,
    max_retries: fields.max_retries,
    retry_interval_hours: fields.retry_interval_hours,
    notes: fields.notes,
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
      `UPDATE campaigns SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING id`,
      values,
    );

    if (result.rows.length === 0) {
      await reply.code(404).send({ error: 'Campaign not found', code: 'NOT_FOUND' });
      return;
    }

    logger.info({ campaignId: idParsed.data.id }, 'Campaign updated');
    await reply.code(200).send({ success: true });
  } catch (err) {
    logger.error({ err }, 'Failed to update campaign');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function transitionStatusHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const idParsed = idParamSchema.safeParse(request.params);
  if (!idParsed.success) {
    await reply.code(400).send({ error: 'Invalid campaign ID', code: 'INVALID_ID' });
    return;
  }

  const bodyParsed = statusTransitionSchema.safeParse(request.body);
  if (!bodyParsed.success) {
    await reply.code(400).send({ error: 'Validation failed', code: 'INVALID_BODY', details: bodyParsed.error.issues });
    return;
  }

  const newStatus = bodyParsed.data.status;

  try {
    const current = await query<{ status: string }>(
      'SELECT status FROM campaigns WHERE id = $1',
      [idParsed.data.id],
    );

    if (current.rows.length === 0) {
      await reply.code(404).send({ error: 'Campaign not found', code: 'NOT_FOUND' });
      return;
    }

    const currentStatus = current.rows[0]!.status;
    const allowed = STATUS_TRANSITIONS[currentStatus] ?? [];

    if (!allowed.includes(newStatus)) {
      await reply.code(409).send({
        error: `Transition from '${currentStatus}' to '${newStatus}' is not allowed`,
        code: 'INVALID_TRANSITION',
        allowed,
      });
      return;
    }

    await query(
      'UPDATE campaigns SET status = $1 WHERE id = $2',
      [newStatus, idParsed.data.id],
    );

    logger.info({ campaignId: idParsed.data.id, from: currentStatus, to: newStatus }, 'Campaign status changed');
    await reply.code(200).send({ success: true, status: newStatus });
  } catch (err) {
    logger.error({ err }, 'Failed to transition campaign status');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function deleteCampaignHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = idParamSchema.safeParse(request.params);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid campaign ID', code: 'INVALID_ID' });
    return;
  }

  try {
    const current = await query<{ status: string }>(
      'SELECT status FROM campaigns WHERE id = $1',
      [parsed.data.id],
    );

    if (current.rows.length === 0) {
      await reply.code(404).send({ error: 'Campaign not found', code: 'NOT_FOUND' });
      return;
    }

    const status = current.rows[0]!.status;
    if (status === 'active' || status === 'paused') {
      await reply.code(409).send({
        error: `Cannot delete a campaign with status '${status}'. Stop it first.`,
        code: 'CAMPAIGN_RUNNING',
      });
      return;
    }

    await query('DELETE FROM campaigns WHERE id = $1', [parsed.data.id]);
    logger.info({ campaignId: parsed.data.id }, 'Campaign deleted');
    await reply.code(200).send({ success: true });
  } catch (err) {
    logger.error({ err }, 'Failed to delete campaign');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export async function campaignRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/campaigns', { preHandler: authenticate }, listCampaignsHandler);
  fastify.get('/campaigns/:id', { preHandler: authenticate }, getCampaignHandler);

  fastify.post('/campaigns', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, createCampaignHandler);

  fastify.put('/campaigns/:id', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, updateCampaignHandler);

  fastify.patch('/campaigns/:id/status', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, transitionStatusHandler);

  fastify.delete('/campaigns/:id', {
    preHandler: [authenticate, requireRole(['admin'])],
  }, deleteCampaignHandler);
}
