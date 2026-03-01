import Telnyx from 'telnyx';
import { z } from 'zod/v4';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withRetry, sleep } from '../utils/retry.js';
import { canCallNumber, markCallMade } from '../session/anti-loop.js';
import { getCallMemory } from '../db/queries.js';
import { routeByPhoneNumber } from '../agents/language-router.js';
import type { Language, CallMemory } from '../types.js';

// ---------------------------------------------------------------------------
// Telnyx SDK client
// ---------------------------------------------------------------------------

const telnyx = new Telnyx(config.TELNYX_API_KEY ?? '');

// ---------------------------------------------------------------------------
// Input validation schemas
// ---------------------------------------------------------------------------

const phoneNumberSchema = z.string().min(1).regex(
  /^\+?[1-9]\d{6,14}$/,
  'Phone number must be in E.164 format (e.g. +38761123456)',
);

const languageSchema = z.enum(['bs-BA', 'sr-RS']);

const campaignIdSchema = z.string().min(1).max(128);

const batchCallsSchema = z.object({
  phoneNumbers: z.array(phoneNumberSchema).min(1).max(10000),
  language: languageSchema,
  campaignId: campaignIdSchema,
  maxConcurrent: z.number().int().min(1).max(100).default(5),
  delayBetweenMs: z.number().int().min(0).max(60000).default(1000),
});

export type BatchCallsInput = z.infer<typeof batchCallsSchema>;

// ---------------------------------------------------------------------------
// Outbound call result type
// ---------------------------------------------------------------------------

export interface OutboundCallResult {
  callControlId: string;
  phoneNumber: string;
  language: Language;
  campaignId: string;
  crossCallMemory: CallMemory | null;
}

export interface BatchCallResult {
  total: number;
  initiated: number;
  skipped: number;
  failed: number;
  results: Array<{
    phoneNumber: string;
    status: 'initiated' | 'skipped_antiloop' | 'failed';
    callControlId?: string;
    error?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Single outbound call
// ---------------------------------------------------------------------------

/**
 * Initiates a single outbound call via the Telnyx API.
 *
 * Performs anti-loop checking, loads cross-call memory if available,
 * and creates the call using the Telnyx SDK.
 *
 * @param phoneNumber - The destination phone number in E.164 format
 * @param language    - The target language ('bs-BA' or 'sr-RS')
 * @param campaignId  - The campaign identifier for tracking
 * @returns The call control ID and associated metadata
 * @throws {Error} When the phone number is blocked by anti-loop or the API call fails
 */
export async function initiateOutboundCall(
  phoneNumber: string,
  language: Language,
  campaignId: string,
): Promise<OutboundCallResult> {
  // Validate inputs
  phoneNumberSchema.parse(phoneNumber);
  languageSchema.parse(language);
  campaignIdSchema.parse(campaignId);

  // Resolve the agent configuration for the chosen language
  const agentConfig =
    language === 'bs-BA'
      ? routeByPhoneNumber(config.TELNYX_PHONE_BS ?? '')
      : routeByPhoneNumber(config.TELNYX_PHONE_SR ?? '');

  const fromNumber = agentConfig.telnyxPhoneNumber;

  // Anti-loop check
  const allowed = await canCallNumber(phoneNumber);

  if (!allowed) {
    logger.warn(
      { phoneNumber, campaignId },
      'Outbound call blocked by anti-loop cooldown',
    );
    throw new Error(
      `Call to ${phoneNumber} blocked by anti-loop cooldown`,
    );
  }

  // Load cross-call memory for personalisation
  let crossCallMemory: CallMemory | null = null;

  if (config.MEMORY_CROSS_CALL_ENABLED) {
    try {
      const memoryRow = await getCallMemory(phoneNumber, campaignId);

      if (memoryRow) {
        crossCallMemory = {
          phoneNumber: memoryRow.phone_number,
          language: memoryRow.language,
          campaignId: memoryRow.campaign_id ?? campaignId,
          conversationSummary: memoryRow.conversation_summary ?? '',
          structuredMemory: memoryRow.structured_memory ?? {
            objections: [],
            tone: 'neutral',
            microCommitment: false,
          },
          outcome: memoryRow.outcome ?? '',
          sentimentScore: memoryRow.sentiment_score ?? 0,
          callCount: memoryRow.call_count,
          lastCallAt: memoryRow.last_call_at,
        };

        logger.info(
          {
            phoneNumber,
            campaignId,
            callCount: crossCallMemory.callCount,
          },
          'Cross-call memory loaded for outbound call',
        );
      }
    } catch (err) {
      logger.error(
        { err, phoneNumber, campaignId },
        'Failed to load cross-call memory — proceeding without it',
      );
    }
  }

  // Initiate the call via Telnyx API with retry
  const callResponse = await withRetry(
    async () => {
      const response = await telnyx.calls.create({
        connection_id: config.TELNYX_APP_ID ?? '',
        to: phoneNumber,
        from: fromNumber,
        answering_machine_detection: 'detect',
        answering_machine_detection_config: {
          total_analysis_time_millis: 5000,
          after_greeting_silence_millis: 1000,
          between_words_silence_millis: 50,
          greeting_duration_millis: 3500,
          initial_silence_millis: 3500,
          maximum_number_of_words: 5,
          silence_threshold: 256,
          greeting_total_analysis_time_millis: 5000,
        },
        stream_url: `wss://${process.env['HOST'] ?? 'localhost'}:${config.PORT}/telnyx/media`,
        stream_track: 'inbound_track',
        client_state: Buffer.from(
          JSON.stringify({ language, campaignId }),
        ).toString('base64'),
      });

      return response;
    },
    {
      maxRetries: 2,
      baseDelayMs: 500,
      service: 'telnyx-outbound-call',
    },
  );

  // Extract call_control_id from the Telnyx response
  const callData = callResponse.data as Record<string, unknown>;
  const rawId = callData['call_control_id'];
  const callControlId = typeof rawId === 'string' ? rawId : '';

  if (!callControlId) {
    throw new Error('Telnyx API returned no call_control_id');
  }

  // Mark the call as made in anti-loop tracking
  await markCallMade(phoneNumber);

  logger.info(
    {
      callControlId,
      phoneNumber,
      fromNumber,
      language,
      campaignId,
    },
    'Outbound call initiated successfully',
  );

  return {
    callControlId,
    phoneNumber,
    language,
    campaignId,
    crossCallMemory,
  };
}

// ---------------------------------------------------------------------------
// Batch outbound calls
// ---------------------------------------------------------------------------

/**
 * Initiates multiple outbound calls with concurrency control and
 * configurable delay between batches.
 *
 * @param phoneNumbers   - Array of destination phone numbers
 * @param language       - The target language for all calls
 * @param campaignId     - The campaign identifier
 * @param maxConcurrent  - Maximum number of simultaneous calls (default: 5)
 * @param delayBetweenMs - Delay in ms between each call initiation (default: 1000)
 * @returns Aggregated results for all calls
 */
export async function initiateBatchCalls(
  phoneNumbers: string[],
  language: Language,
  campaignId: string,
  maxConcurrent = 5,
  delayBetweenMs = 1000,
): Promise<BatchCallResult> {
  // Validate batch input
  batchCallsSchema.parse({
    phoneNumbers,
    language,
    campaignId,
    maxConcurrent,
    delayBetweenMs,
  });

  logger.info(
    {
      totalNumbers: phoneNumbers.length,
      language,
      campaignId,
      maxConcurrent,
      delayBetweenMs,
    },
    'Starting batch outbound calls',
  );

  const results: BatchCallResult['results'] = [];
  let initiated = 0;
  let skipped = 0;
  let failed = 0;

  // Process in chunks of maxConcurrent
  for (let i = 0; i < phoneNumbers.length; i += maxConcurrent) {
    const chunk = phoneNumbers.slice(i, i + maxConcurrent);

    const chunkResults = await Promise.allSettled(
      chunk.map(async (phoneNumber) => {
        // Anti-loop pre-check to avoid unnecessary API calls
        const allowed = await canCallNumber(phoneNumber);

        if (!allowed) {
          skipped++;
          return {
            phoneNumber,
            status: 'skipped_antiloop' as const,
          };
        }

        try {
          const result = await initiateOutboundCall(
            phoneNumber,
            language,
            campaignId,
          );
          initiated++;
          return {
            phoneNumber,
            status: 'initiated' as const,
            callControlId: result.callControlId,
          };
        } catch (err) {
          failed++;
          const errorMessage =
            err instanceof Error ? err.message : String(err);
          logger.error(
            { err, phoneNumber, campaignId },
            'Failed to initiate outbound call in batch',
          );
          return {
            phoneNumber,
            status: 'failed' as const,
            error: errorMessage,
          };
        }
      }),
    );

    // Collect results from settled promises
    for (const settled of chunkResults) {
      if (settled.status === 'fulfilled') {
        results.push(settled.value);
      } else {
        failed++;
        results.push({
          phoneNumber: 'unknown',
          status: 'failed',
          error: settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason),
        });
      }
    }

    // Delay between batches (skip delay after the last batch)
    if (i + maxConcurrent < phoneNumbers.length && delayBetweenMs > 0) {
      logger.debug(
        { delayBetweenMs, batchIndex: Math.floor(i / maxConcurrent) },
        'Delaying before next batch',
      );
      await sleep(delayBetweenMs);
    }
  }

  logger.info(
    {
      total: phoneNumbers.length,
      initiated,
      skipped,
      failed,
      campaignId,
    },
    'Batch outbound calls completed',
  );

  return {
    total: phoneNumbers.length,
    initiated,
    skipped,
    failed,
    results,
  };
}
