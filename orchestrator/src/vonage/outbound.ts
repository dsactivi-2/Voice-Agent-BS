import { Vonage } from '@vonage/server-sdk';
import { HttpMethod } from '@vonage/voice';
import { z } from 'zod/v4';
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { canCallNumber, markCallMade } from '../session/anti-loop.js';
import type { Language } from '../types.js';

// ---------------------------------------------------------------------------
// Vonage SDK client (lazy initialisation)
// ---------------------------------------------------------------------------

let vonageClient: Vonage | null = null;

/**
 * Returns the Vonage SDK client, creating it on first use.
 * Requires VONAGE_APPLICATION_ID and VONAGE_PRIVATE_KEY_PATH to be set.
 */
function getVonageClient(): Vonage {
  if (vonageClient) return vonageClient;

  const applicationId = config.VONAGE_APPLICATION_ID;
  const privateKeyPath = config.VONAGE_PRIVATE_KEY_PATH;

  if (!applicationId || !privateKeyPath) {
    throw new Error(
      'Vonage configuration missing: VONAGE_APPLICATION_ID and VONAGE_PRIVATE_KEY_PATH are required',
    );
  }

  const privateKey = readFileSync(privateKeyPath, 'utf-8');

  vonageClient = new Vonage({
    applicationId,
    privateKey,
  });

  return vonageClient;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const phoneNumberSchema = z.string().min(1).regex(
  /^\+?[1-9]\d{6,14}$/,
  'Phone number must be in E.164 format (e.g. +38761123456)',
);

const campaignIdSchema = z.string().min(1).max(128);

// ---------------------------------------------------------------------------
// Outbound call result type
// ---------------------------------------------------------------------------

export interface VonageOutboundCallResult {
  uuid: string;
  phoneNumber: string;
  language: Language;
  campaignId: string;
}

// ---------------------------------------------------------------------------
// Single outbound call
// ---------------------------------------------------------------------------

/**
 * Initiates a single outbound call via the Vonage Voice API.
 *
 * The call is created with an NCCO that instructs Vonage to connect
 * the audio to our WebSocket endpoint for real-time streaming.
 *
 * @param phoneNumber - The destination phone number in E.164 format
 * @param language    - The target language ('bs-BA' or 'sr-RS')
 * @param campaignId  - The campaign identifier for tracking
 * @returns The Vonage call UUID and associated metadata
 * @throws {Error} When the phone number is blocked by anti-loop or the API call fails
 */
export async function initiateOutboundCall(
  phoneNumber: string,
  language: Language,
  campaignId: string,
): Promise<VonageOutboundCallResult> {
  // Validate inputs
  phoneNumberSchema.parse(phoneNumber);
  campaignIdSchema.parse(campaignId);

  const vonagePhoneNumber = config.VONAGE_PHONE_NUMBER;
  if (!vonagePhoneNumber) {
    throw new Error('VONAGE_PHONE_NUMBER is not configured');
  }

  // Anti-loop check
  const allowed = await canCallNumber(phoneNumber);

  if (!allowed) {
    logger.warn(
      { phoneNumber, campaignId },
      'Vonage outbound call blocked by anti-loop cooldown',
    );
    throw new Error(
      `Call to ${phoneNumber} blocked by anti-loop cooldown`,
    );
  }

  const baseUrl = process.env['HOST'] ?? 'localhost';
  const answerUrl = `https://${baseUrl}/vonage/answer`;
  const eventUrl = `https://${baseUrl}/vonage/events`;

  // Initiate the call via Vonage API with retry
  const vonage = getVonageClient();

  const callResponse = await withRetry(
    async () => {
      const response = await vonage.voice.createOutboundCall({
        to: [{
          type: 'phone' as const,
          number: phoneNumber.replace(/^\+/, ''),
        }],
        from: {
          type: 'phone' as const,
          number: vonagePhoneNumber.replace(/^\+/, ''),
        },
        answerUrl: [answerUrl],
        answerMethod: HttpMethod.GET,
        eventUrl: [eventUrl],
        eventMethod: HttpMethod.POST,
      });

      return response;
    },
    {
      maxRetries: 2,
      baseDelayMs: 500,
      service: 'vonage-outbound-call',
    },
  );

  // Extract UUID from the Vonage response
  const uuid = String((callResponse as Record<string, unknown>)['uuid'] ?? '');

  if (!uuid) {
    throw new Error('Vonage API returned no call UUID');
  }

  // Mark the call as made in anti-loop tracking
  await markCallMade(phoneNumber);

  logger.info(
    {
      uuid,
      phoneNumber,
      fromNumber: vonagePhoneNumber,
      language,
      campaignId,
    },
    'Vonage outbound call initiated successfully',
  );

  return {
    uuid,
    phoneNumber,
    language,
    campaignId,
  };
}

/**
 * Hangs up an active Vonage call by UUID.
 *
 * @param uuid - The Vonage call UUID to terminate
 */
export async function hangUpCall(uuid: string): Promise<void> {
  const vonage = getVonageClient();

  try {
    await vonage.voice.hangupCall(uuid);

    logger.info({ uuid }, 'Vonage call hung up successfully');
  } catch (err) {
    logger.error({ err, uuid }, 'Failed to hang up Vonage call');
    throw err;
  }
}
