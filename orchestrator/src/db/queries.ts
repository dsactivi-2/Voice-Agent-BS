import { query } from './client.js';
import { logger } from '../utils/logger.js';
import type { CallResult, Language, LLMMode, ABGroup, Speaker, StructuredMemory } from '../types.js';

// ---------------------------------------------------------------------------
// Row types — mirror the actual DB column names (snake_case)
// ---------------------------------------------------------------------------

export interface CallRow {
  id: string;
  call_id: string;
  phone_number: string;
  language: Language;
  campaign_id: string | null;
  ab_group: ABGroup | null;
  llm_mode_final: LLMMode | null;
  duration_sec: number | null;
  turn_count: number;
  result: CallResult | null;
  error_log: string | null;
  created_at: Date;
  ended_at: Date | null;
}

export interface TurnRow {
  id: string;
  call_id: string;
  turn_number: number;
  speaker: Speaker;
  text: string;
  interest_score: number | null;
  complexity_score: number | null;
  llm_mode: LLMMode | null;
  latency_ms: number | null;
  timestamp: Date;
}

export interface MetricRow {
  id: string;
  call_id: string;
  metric_name: string;
  metric_value: number;
  recorded_at: Date;
}

export interface CallMemoryRow {
  id: string;
  phone_number: string;
  language: Language;
  campaign_id: string | null;
  conversation_summary: string | null;
  structured_memory: StructuredMemory | null;
  outcome: string | null;
  sentiment_score: number | null;
  call_count: number;
  last_call_at: Date;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Param types
// ---------------------------------------------------------------------------

export interface CreateCallParams {
  callId: string;
  phoneNumber: string;
  language: Language;
  campaignId?: string;
  abGroup?: ABGroup;
  llmModeFinal?: LLMMode;
}

export interface UpdateCallResultParams {
  callId: string;
  result: CallResult;
  errorLog?: string;
  durationSec?: number;
  turnCount?: number;
}

export interface InsertTurnParams {
  callId: string;
  turnNumber: number;
  speaker: Speaker;
  text: string;
  interestScore?: number;
  complexityScore?: number;
  llmMode?: LLMMode;
  latencyMs?: number;
}

export interface UpsertCallMemoryParams {
  phoneNumber: string;
  language: Language;
  campaignId?: string;
  conversationSummary?: string;
  structuredMemory?: StructuredMemory;
  outcome?: string;
  sentimentScore?: number;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/**
 * Inserts a new call row at the start of a call session.
 */
export async function createCall(params: CreateCallParams): Promise<void> {
  const { callId, phoneNumber, language, campaignId, abGroup, llmModeFinal } = params;

  const sql = `
    INSERT INTO calls (call_id, phone_number, language, campaign_id, ab_group, llm_mode_final)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (call_id) DO NOTHING
  `;

  try {
    await query(sql, [
      callId,
      phoneNumber,
      language,
      campaignId ?? null,
      abGroup ?? null,
      llmModeFinal ?? null,
    ]);
    logger.info({ callId, phoneNumber, language }, 'Call record created');
  } catch (err) {
    logger.error({ err, callId }, 'Failed to create call record');
    throw err;
  }
}

/**
 * Updates a call row with the final outcome after the call ends.
 */
export async function updateCallResult(params: UpdateCallResultParams): Promise<void> {
  const { callId, result, errorLog, durationSec, turnCount } = params;

  const sql = `
    UPDATE calls
    SET
      result       = $2,
      error_log    = $3,
      duration_sec = $4,
      turn_count   = COALESCE($5, turn_count),
      ended_at     = NOW()
    WHERE call_id = $1
  `;

  try {
    const res = await query(sql, [
      callId,
      result,
      errorLog ?? null,
      durationSec ?? null,
      turnCount ?? null,
    ]);

    if (res.rowCount === 0) {
      logger.warn({ callId }, 'updateCallResult: no rows matched call_id');
    } else {
      logger.info({ callId, result, durationSec, turnCount }, 'Call result updated');
    }
  } catch (err) {
    logger.error({ err, callId }, 'Failed to update call result');
    throw err;
  }
}

/**
 * Fetches a single call row by its call_id.
 * Returns null when no row exists.
 */
export async function getCallByCallId(callId: string): Promise<CallRow | null> {
  const sql = `
    SELECT
      id, call_id, phone_number, language, campaign_id,
      ab_group, llm_mode_final, duration_sec, turn_count,
      result, error_log, created_at, ended_at
    FROM calls
    WHERE call_id = $1
    LIMIT 1
  `;

  try {
    const res = await query<CallRow>(sql, [callId]);
    return res.rows[0] ?? null;
  } catch (err) {
    logger.error({ err, callId }, 'Failed to fetch call by call_id');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * Inserts a conversation turn (user utterance or bot reply).
 */
export async function insertTurn(params: InsertTurnParams): Promise<void> {
  const {
    callId,
    turnNumber,
    speaker,
    text,
    interestScore,
    complexityScore,
    llmMode,
    latencyMs,
  } = params;

  const sql = `
    INSERT INTO turns
      (call_id, turn_number, speaker, text, interest_score, complexity_score, llm_mode, latency_ms)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (call_id, turn_number) DO NOTHING
  `;

  try {
    await query(sql, [
      callId,
      turnNumber,
      speaker,
      text,
      interestScore ?? null,
      complexityScore ?? null,
      llmMode ?? null,
      latencyMs ?? null,
    ]);
    logger.debug({ callId, turnNumber, speaker }, 'Turn inserted');
  } catch (err) {
    logger.error({ err, callId, turnNumber }, 'Failed to insert turn');
    throw err;
  }
}

/**
 * Returns all turns for the given call_id, ordered by turn_number ascending.
 */
export async function getTurnsByCallId(callId: string): Promise<TurnRow[]> {
  const sql = `
    SELECT
      id, call_id, turn_number, speaker, text,
      interest_score, complexity_score, llm_mode, latency_ms, timestamp
    FROM turns
    WHERE call_id = $1
    ORDER BY turn_number ASC
  `;

  try {
    const res = await query<TurnRow>(sql, [callId]);
    return res.rows;
  } catch (err) {
    logger.error({ err, callId }, 'Failed to fetch turns for call');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Appends a named numeric metric for a call (e.g. RTT, CPU sample).
 */
export async function insertMetric(
  callId: string,
  metricName: string,
  metricValue: number,
): Promise<void> {
  const sql = `
    INSERT INTO call_metrics (call_id, metric_name, metric_value)
    VALUES ($1, $2, $3)
  `;

  try {
    await query(sql, [callId, metricName, metricValue]);
    logger.trace({ callId, metricName, metricValue }, 'Metric inserted');
  } catch (err) {
    logger.error({ err, callId, metricName }, 'Failed to insert metric');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Call Memory (cross-call persistent context)
// ---------------------------------------------------------------------------

/**
 * Returns the cross-call memory record for a (phoneNumber, campaignId) pair.
 * Returns null when the caller has no prior interaction history.
 */
export async function getCallMemory(
  phoneNumber: string,
  campaignId: string,
): Promise<CallMemoryRow | null> {
  const sql = `
    SELECT
      id, phone_number, language, campaign_id,
      conversation_summary, structured_memory, outcome,
      sentiment_score, call_count, last_call_at, created_at
    FROM call_memory
    WHERE phone_number = $1
      AND campaign_id  = $2
    LIMIT 1
  `;

  try {
    const res = await query<CallMemoryRow>(sql, [phoneNumber, campaignId]);
    return res.rows[0] ?? null;
  } catch (err) {
    logger.error({ err, phoneNumber, campaignId }, 'Failed to fetch call memory');
    throw err;
  }
}

/**
 * Inserts or updates the cross-call memory record for a caller.
 * On conflict (phone_number, campaign_id) the existing row is updated:
 * - call_count is incremented
 * - last_call_at is refreshed to NOW()
 * - All provided fields are overwritten
 */
export async function upsertCallMemory(params: UpsertCallMemoryParams): Promise<void> {
  const {
    phoneNumber,
    language,
    campaignId,
    conversationSummary,
    structuredMemory,
    outcome,
    sentimentScore,
  } = params;

  const sql = `
    INSERT INTO call_memory
      (phone_number, language, campaign_id, conversation_summary,
       structured_memory, outcome, sentiment_score, call_count, last_call_at)
    VALUES
      ($1, $2, $3, $4, $5::jsonb, $6, $7, 1, NOW())
    ON CONFLICT (phone_number, campaign_id)
    DO UPDATE SET
      language             = EXCLUDED.language,
      conversation_summary = EXCLUDED.conversation_summary,
      structured_memory    = EXCLUDED.structured_memory,
      outcome              = EXCLUDED.outcome,
      sentiment_score      = EXCLUDED.sentiment_score,
      call_count           = call_memory.call_count + 1,
      last_call_at         = NOW()
  `;

  try {
    await query(sql, [
      phoneNumber,
      language,
      campaignId ?? null,
      conversationSummary ?? null,
      structuredMemory ? JSON.stringify(structuredMemory) : null,
      outcome ?? null,
      sentimentScore ?? null,
    ]);
    logger.info({ phoneNumber, campaignId }, 'Call memory upserted');
  } catch (err) {
    logger.error({ err, phoneNumber, campaignId }, 'Failed to upsert call memory');
    throw err;
  }
}
