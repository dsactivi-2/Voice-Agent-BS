import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod/v4';
import { query } from '../db/pool.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { parseCsvPreview, parseCsvAndMap, normalizePhone, LEAD_MAPPABLE_FIELDS } from '../utils/csv-parser.js';
import type { LeadFieldMapping } from '../utils/csv-parser.js';

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const LEAD_STATUSES = ['new', 'queued', 'dialing', 'connected', 'disposed', 'dnc', 'failed'] as const;

const campaignIdParam = z.object({ campaignId: z.string().uuid() });
const listIdParam = z.object({ campaignId: z.string().uuid(), listId: z.string().uuid() });
const leadIdParam = z.object({ leadId: z.string().uuid() });

const listLeadsQuerySchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

const fieldMappingSchema = z.object({
  phone_primary: z.string().min(1),
  phone_alt1: z.string().optional(),
  phone_alt2: z.string().optional(),
  phone_alt3: z.string().optional(),
  phone_alt4: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string().optional(),
  company: z.string().optional(),
  notes: z.string().optional(),
});

const setDispositionSchema = z.object({
  disposition_code: z.string().min(1).max(50),
  notes: z.string().max(2000).optional(),
});

// DNC schemas
const addDncSchema = z.object({
  phone: z.string().min(5).max(30),
  reason: z.string().max(500).optional(),
  source: z.enum(['manual', 'import', 'api']).default('manual'),
});

const checkDncSchema = z.object({
  phone: z.string().min(5).max(30),
});

const dncListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().max(200).optional(),
});

// ─── DB row types ─────────────────────────────────────────────────────────────

interface LeadListRow {
  id: string;
  campaign_id: string;
  name: string;
  filename: string | null;
  total_count: number;
  processed_count: number;
  created_at: string;
}

interface LeadRow {
  id: string;
  list_id: string;
  campaign_id: string;
  phone_primary: string;
  phone_alt1: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company: string | null;
  status: string;
  disposition_code: string | null;
  retry_count: number;
  last_called_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface DncRow {
  id: string;
  phone: string;
  reason: string | null;
  source: string;
  added_by: string | null;
  added_at: string;
}

// ─── CSV Preview handler ──────────────────────────────────────────────────────

async function csvPreviewHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const idParsed = campaignIdParam.safeParse(request.params);
  if (!idParsed.success) {
    await reply.code(400).send({ error: 'Invalid campaign ID', code: 'INVALID_ID' });
    return;
  }

  try {
    const data = await request.file();
    if (!data) {
      await reply.code(400).send({ error: 'No file uploaded', code: 'MISSING_FILE' });
      return;
    }

    const ext = data.filename.toLowerCase();
    if (!ext.endsWith('.csv') && !data.mimetype.includes('csv')) {
      await reply.code(400).send({ error: 'Only CSV files are accepted', code: 'INVALID_FILE_TYPE' });
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk as Buffer);
    }
    const buffer = Buffer.concat(chunks);

    if (buffer.length > 20 * 1024 * 1024) {
      await reply.code(413).send({ error: 'CSV exceeds 20 MB limit', code: 'FILE_TOO_LARGE' });
      return;
    }

    const preview = parseCsvPreview(buffer);

    await reply.code(200).send({
      headers: preview.headers,
      preview_rows: preview.previewRows,
      total_rows: preview.totalRows,
      mappable_fields: LEAD_MAPPABLE_FIELDS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'CSV preview failed');
    await reply.code(422).send({ error: `CSV parsing failed: ${message}`, code: 'CSV_ERROR' });
  }
}

// ─── CSV Import handler ───────────────────────────────────────────────────────

async function csvImportHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const idParsed = campaignIdParam.safeParse(request.params);
  if (!idParsed.success) {
    await reply.code(400).send({ error: 'Invalid campaign ID', code: 'INVALID_ID' });
    return;
  }

  const campaignId = idParsed.data.campaignId;

  // Verify campaign exists
  const campaignCheck = await query<{ id: string }>(
    'SELECT id FROM campaigns WHERE id = $1',
    [campaignId],
  );
  if (campaignCheck.rows.length === 0) {
    await reply.code(404).send({ error: 'Campaign not found', code: 'NOT_FOUND' });
    return;
  }

  let csvBuffer: Buffer;
  let filename: string;
  let listName: string;
  let mapping: LeadFieldMapping;

  try {
    const parts = request.parts();
    let csvData: Buffer | null = null;
    let csvFilename = 'import.csv';
    let mappingRaw: string | null = null;
    let nameRaw: string | null = null;

    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'file') {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(chunk as Buffer);
        }
        csvData = Buffer.concat(chunks);
        csvFilename = part.filename;
      } else if (part.type === 'field') {
        if (part.fieldname === 'mapping') mappingRaw = part.value as string;
        if (part.fieldname === 'name') nameRaw = part.value as string;
      }
    }

    if (!csvData || csvData.length === 0) {
      await reply.code(400).send({ error: 'No CSV file in "file" field', code: 'MISSING_FILE' });
      return;
    }

    if (csvData.length > 20 * 1024 * 1024) {
      await reply.code(413).send({ error: 'CSV exceeds 20 MB limit', code: 'FILE_TOO_LARGE' });
      return;
    }

    if (!mappingRaw) {
      await reply.code(400).send({ error: '"mapping" field is required (JSON string)', code: 'MISSING_MAPPING' });
      return;
    }

    let rawMapping: unknown;
    try {
      rawMapping = JSON.parse(mappingRaw);
    } catch {
      await reply.code(400).send({ error: 'Invalid JSON in "mapping" field', code: 'INVALID_MAPPING_JSON' });
      return;
    }

    const mappingParsed = fieldMappingSchema.safeParse(rawMapping);
    if (!mappingParsed.success) {
      await reply.code(400).send({ error: 'Invalid field mapping', code: 'INVALID_MAPPING', details: mappingParsed.error.issues });
      return;
    }

    csvBuffer = csvData;
    filename = csvFilename;
    listName = nameRaw ?? filename;
    mapping = mappingParsed.data as LeadFieldMapping;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Failed to parse multipart import request');
    await reply.code(422).send({ error: `Request parsing failed: ${message}`, code: 'PARSE_ERROR' });
    return;
  }

  let leads: ReturnType<typeof parseCsvAndMap>;
  try {
    leads = parseCsvAndMap(csvBuffer, mapping);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await reply.code(422).send({ error: `CSV parsing failed: ${message}`, code: 'CSV_ERROR' });
    return;
  }

  if (leads.length === 0) {
    await reply.code(422).send({
      error: 'No valid leads found. Check that phone_primary column mapping is correct.',
      code: 'NO_LEADS',
    });
    return;
  }

  // Fetch DNC set for pre-filtering
  const dncResult = await query<{ phone: string }>('SELECT phone FROM dnc_numbers', []);
  const dncSet = new Set(dncResult.rows.map((r) => r.phone));

  try {
    // Create lead list record
    const listResult = await query<{ id: string }>(
      `INSERT INTO lead_lists (campaign_id, name, filename, total_count)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [campaignId, listName, filename, leads.length],
    );
    const listId = listResult.rows[0]!.id;

    let importedCount = 0;
    let skippedDnc = 0;
    let skippedDuplicate = 0;

    for (const lead of leads) {
      const phone = normalizePhone(lead.phone_primary);

      if (dncSet.has(phone)) {
        skippedDnc++;
        continue;
      }

      try {
        await query(
          `INSERT INTO leads (
             list_id, campaign_id, phone_primary, phone_alt1, phone_alt2,
             phone_alt3, phone_alt4, first_name, last_name, email, company,
             notes, custom_fields
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT DO NOTHING`,
          [
            listId, campaignId, phone,
            lead.phone_alt1 ?? null, lead.phone_alt2 ?? null,
            lead.phone_alt3 ?? null, lead.phone_alt4 ?? null,
            lead.first_name ?? null, lead.last_name ?? null,
            lead.email ?? null, lead.company ?? null,
            lead.notes ?? null, JSON.stringify(lead.custom_fields),
          ],
        );
        importedCount++;
      } catch {
        skippedDuplicate++;
      }
    }

    // Update processed_count on the list
    await query(
      'UPDATE lead_lists SET processed_count = $1 WHERE id = $2',
      [importedCount, listId],
    );

    logger.info(
      { campaignId, listId, importedCount, skippedDnc, skippedDuplicate },
      'CSV import complete',
    );

    await reply.code(201).send({
      listId,
      imported: importedCount,
      skipped_dnc: skippedDnc,
      skipped_duplicate: skippedDuplicate,
      total_in_file: leads.length,
    });
  } catch (err) {
    logger.error({ err }, 'CSV import DB error');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

// ─── Lead list handlers ───────────────────────────────────────────────────────

async function listLeadListsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = campaignIdParam.safeParse(request.params);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid campaign ID', code: 'INVALID_ID' });
    return;
  }

  try {
    const result = await query<LeadListRow>(
      `SELECT id, campaign_id, name, filename, total_count, processed_count, created_at
       FROM lead_lists WHERE campaign_id = $1 ORDER BY created_at DESC`,
      [parsed.data.campaignId],
    );
    await reply.code(200).send({ lists: result.rows, total: result.rows.length });
  } catch (err) {
    logger.error({ err }, 'Failed to list lead lists');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function getLeadListHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = listIdParam.safeParse(request.params);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid ID', code: 'INVALID_ID' });
    return;
  }

  try {
    const result = await query<LeadListRow>(
      `SELECT id, campaign_id, name, filename, total_count, processed_count, created_at
       FROM lead_lists WHERE id = $1 AND campaign_id = $2`,
      [parsed.data.listId, parsed.data.campaignId],
    );

    if (result.rows.length === 0) {
      await reply.code(404).send({ error: 'Lead list not found', code: 'NOT_FOUND' });
      return;
    }

    await reply.code(200).send({ list: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to get lead list');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function listLeadsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const idParsed = listIdParam.safeParse(request.params);
  if (!idParsed.success) {
    await reply.code(400).send({ error: 'Invalid ID', code: 'INVALID_ID' });
    return;
  }

  const queryParsed = listLeadsQuerySchema.safeParse(request.query);
  if (!queryParsed.success) {
    await reply.code(400).send({ error: 'Invalid query parameters', code: 'INVALID_QUERY' });
    return;
  }

  const { status, search, page, pageSize } = queryParsed.data;
  const offset = (page - 1) * pageSize;

  const conditions: string[] = ['l.list_id = $1', 'l.campaign_id = $2'];
  const values: unknown[] = [idParsed.data.listId, idParsed.data.campaignId];

  if (status) {
    values.push(status);
    conditions.push(`l.status = $${values.length}`);
  }

  if (search) {
    values.push(`%${search}%`);
    const n = values.length;
    conditions.push(`(l.phone_primary ILIKE $${n} OR l.first_name ILIKE $${n} OR l.last_name ILIKE $${n})`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  try {
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM leads l ${where}`,
      values,
    );

    values.push(pageSize);
    values.push(offset);

    const result = await query<LeadRow>(
      `SELECT l.id, l.list_id, l.campaign_id, l.phone_primary, l.phone_alt1,
              l.first_name, l.last_name, l.email, l.company,
              l.status, l.disposition_code, l.retry_count,
              l.last_called_at, l.notes, l.created_at, l.updated_at
       FROM leads l ${where}
       ORDER BY l.created_at ASC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    await reply.code(200).send({
      leads: result.rows,
      total: Number(countResult.rows[0]?.count ?? 0),
      page,
      pageSize,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to list leads');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function deleteLeadListHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = listIdParam.safeParse(request.params);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid ID', code: 'INVALID_ID' });
    return;
  }

  try {
    const result = await query<{ id: string }>(
      'DELETE FROM lead_lists WHERE id = $1 AND campaign_id = $2 RETURNING id',
      [parsed.data.listId, parsed.data.campaignId],
    );

    if (result.rows.length === 0) {
      await reply.code(404).send({ error: 'Lead list not found', code: 'NOT_FOUND' });
      return;
    }

    logger.info({ ...parsed.data }, 'Lead list deleted');
    await reply.code(200).send({ success: true });
  } catch (err) {
    logger.error({ err }, 'Failed to delete lead list');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

// ─── Disposition set on lead ──────────────────────────────────────────────────

async function setLeadDispositionHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const idParsed = leadIdParam.safeParse(request.params);
  if (!idParsed.success) {
    await reply.code(400).send({ error: 'Invalid lead ID', code: 'INVALID_ID' });
    return;
  }

  const bodyParsed = setDispositionSchema.safeParse(request.body);
  if (!bodyParsed.success) {
    await reply.code(400).send({ error: 'Validation failed', code: 'INVALID_BODY', details: bodyParsed.error.issues });
    return;
  }

  const { disposition_code, notes } = bodyParsed.data;

  try {
    // Check the disposition exists for the lead's campaign and whether it's DNC
    const dispositionCheck = await query<{ is_dnc: boolean; campaign_id: string }>(
      `SELECT d.is_dnc, l.campaign_id
       FROM leads l
       JOIN dispositions d ON d.campaign_id = l.campaign_id AND d.code = $2
       WHERE l.id = $1`,
      [idParsed.data.leadId, disposition_code],
    );

    if (dispositionCheck.rows.length === 0) {
      await reply.code(422).send({
        error: `Disposition code '${disposition_code}' not found for this lead's campaign`,
        code: 'INVALID_DISPOSITION',
      });
      return;
    }

    const { is_dnc } = dispositionCheck.rows[0]!;
    const newStatus = is_dnc ? 'dnc' : 'disposed';

    await query(
      `UPDATE leads
       SET status = $1, disposition_code = $2, notes = COALESCE($3, notes)
       WHERE id = $4`,
      [newStatus, disposition_code, notes ?? null, idParsed.data.leadId],
    );

    // If DNC disposition, add to global DNC registry
    if (is_dnc) {
      const leadPhone = await query<{ phone_primary: string }>(
        'SELECT phone_primary FROM leads WHERE id = $1',
        [idParsed.data.leadId],
      );
      const phone = leadPhone.rows[0]?.phone_primary;
      if (phone) {
        await query(
          `INSERT INTO dnc_numbers (phone, reason, source)
           VALUES ($1, $2, 'call')
           ON CONFLICT (phone) DO NOTHING`,
          [phone, `Disposition: ${disposition_code}`],
        );
      }
    }

    logger.info({ leadId: idParsed.data.leadId, disposition_code, is_dnc }, 'Lead disposition set');
    await reply.code(200).send({ success: true, status: newStatus });
  } catch (err) {
    logger.error({ err }, 'Failed to set lead disposition');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

// ─── DNC handlers ─────────────────────────────────────────────────────────────

async function listDncHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = dncListQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid query', code: 'INVALID_QUERY' });
    return;
  }

  const { page, pageSize, search } = parsed.data;
  const offset = (page - 1) * pageSize;
  const values: unknown[] = [];
  let where = '';

  if (search) {
    values.push(`%${search}%`);
    where = `WHERE phone ILIKE $${values.length}`;
  }

  try {
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM dnc_numbers ${where}`,
      values,
    );

    values.push(pageSize);
    values.push(offset);

    const result = await query<DncRow>(
      `SELECT id, phone, reason, source, added_by, added_at
       FROM dnc_numbers ${where}
       ORDER BY added_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    await reply.code(200).send({
      dnc: result.rows,
      total: Number(countResult.rows[0]?.count ?? 0),
      page,
      pageSize,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to list DNC numbers');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function addDncHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = addDncSchema.safeParse(request.body);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Validation failed', code: 'INVALID_BODY', details: parsed.error.issues });
    return;
  }

  const { phone, reason, source } = parsed.data;
  const normalised = normalizePhone(phone);
  const userId = (request.user as { userId: string } | undefined)?.userId ?? null;

  try {
    const result = await query<{ id: string }>(
      `INSERT INTO dnc_numbers (phone, reason, source, added_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (phone) DO UPDATE SET reason = EXCLUDED.reason
       RETURNING id`,
      [normalised, reason ?? null, source, userId],
    );

    logger.info({ phone: normalised, source }, 'Phone added to DNC');
    await reply.code(201).send({ dncId: result.rows[0]?.id, phone: normalised });
  } catch (err) {
    logger.error({ err }, 'Failed to add DNC number');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function deleteDncHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Invalid DNC ID', code: 'INVALID_ID' });
    return;
  }

  try {
    const result = await query<{ id: string }>(
      'DELETE FROM dnc_numbers WHERE id = $1 RETURNING id',
      [parsed.data.id],
    );

    if (result.rows.length === 0) {
      await reply.code(404).send({ error: 'DNC number not found', code: 'NOT_FOUND' });
      return;
    }

    logger.info({ dncId: parsed.data.id }, 'DNC number removed');
    await reply.code(200).send({ success: true });
  } catch (err) {
    logger.error({ err }, 'Failed to delete DNC number');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

async function checkDncHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = checkDncSchema.safeParse(request.body);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'Validation failed', code: 'INVALID_BODY', details: parsed.error.issues });
    return;
  }

  const phone = normalizePhone(parsed.data.phone);

  try {
    const result = await query<{ id: string; reason: string | null }>(
      'SELECT id, reason FROM dnc_numbers WHERE phone = $1',
      [phone],
    );

    const isDnc = result.rows.length > 0;
    await reply.code(200).send({
      phone,
      is_dnc: isDnc,
      ...(isDnc ? { reason: result.rows[0]?.reason } : {}),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to check DNC');
    await reply.code(500).send({ error: 'Internal server error', code: 'DB_ERROR' });
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export async function leadRoutes(fastify: FastifyInstance): Promise<void> {
  // CSV preview + import — multipart plugin already registered by knowledge-bases
  // (Fastify plugins are per-instance; re-register safely here)
  try {
    await fastify.register(import('@fastify/multipart'), {
      limits: { fileSize: 20 * 1024 * 1024, files: 1 },
    });
  } catch {
    // Already registered — ignore duplicate registration error
  }

  // ── Lead lists ─────────────────────────────────────────────────────────────

  // GET /campaigns/:campaignId/lists
  fastify.get('/campaigns/:campaignId/lists', {
    preHandler: authenticate,
  }, listLeadListsHandler);

  // GET /campaigns/:campaignId/lists/:listId
  fastify.get('/campaigns/:campaignId/lists/:listId', {
    preHandler: authenticate,
  }, getLeadListHandler);

  // POST /campaigns/:campaignId/lists/preview — upload CSV, return columns + preview
  fastify.post('/campaigns/:campaignId/lists/preview', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, csvPreviewHandler);

  // POST /campaigns/:campaignId/lists/import — upload CSV + mapping JSON field → import
  fastify.post('/campaigns/:campaignId/lists/import', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, csvImportHandler);

  // GET /campaigns/:campaignId/lists/:listId/leads — paginated leads
  fastify.get('/campaigns/:campaignId/lists/:listId/leads', {
    preHandler: authenticate,
  }, listLeadsHandler);

  // DELETE /campaigns/:campaignId/lists/:listId
  fastify.delete('/campaigns/:campaignId/lists/:listId', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, deleteLeadListHandler);

  // ── Lead disposition ───────────────────────────────────────────────────────

  // PATCH /leads/:leadId/disposition
  fastify.patch('/leads/:leadId/disposition', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, setLeadDispositionHandler);

  // ── DNC ────────────────────────────────────────────────────────────────────

  // GET /dnc
  fastify.get('/dnc', { preHandler: authenticate }, listDncHandler);

  // POST /dnc — add number
  fastify.post('/dnc', {
    preHandler: [authenticate, requireRole(['admin', 'manager'])],
  }, addDncHandler);

  // DELETE /dnc/:id
  fastify.delete('/dnc/:id', {
    preHandler: [authenticate, requireRole(['admin'])],
  }, deleteDncHandler);

  // POST /dnc/check — check if phone is in DNC
  fastify.post('/dnc/check', {
    preHandler: authenticate,
  }, checkDncHandler);
}
