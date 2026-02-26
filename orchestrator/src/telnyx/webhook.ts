import { z } from 'zod/v4';
import { createVerify } from 'node:crypto';
import type { FastifyRequest, FastifyReply, RouteHandlerMethod } from 'fastify';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { canCallNumber, markCallMade } from '../session/anti-loop.js';
import { routeByPhoneNumber } from '../agents/language-router.js';
import { createCall, updateCallResult, upsertCallMemory } from '../db/queries.js';
import { incrementActiveCalls, decrementActiveCalls } from '../server.js';

// ---------------------------------------------------------------------------
// Zod schemas for Telnyx webhook payloads
// ---------------------------------------------------------------------------

const telnyxCallPayloadSchema = z.object({
  call_control_id: z.string().min(1),
  call_leg_id: z.string().optional(),
  call_session_id: z.string().optional(),
  connection_id: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  direction: z.enum(['incoming', 'outgoing']).optional(),
  state: z.string().optional(),
  client_state: z.string().optional(),
});

const telnyxMachineDetectionPayloadSchema = telnyxCallPayloadSchema.extend({
  result: z.enum(['human', 'machine', 'not_sure']),
});

const telnyxWebhookEventSchema = z.object({
  event_type: z.string().min(1),
  id: z.string().optional(),
  occurred_at: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});

const telnyxWebhookBodySchema = z.object({
  data: telnyxWebhookEventSchema,
});

export type TelnyxWebhookBody = z.infer<typeof telnyxWebhookBodySchema>;
export type TelnyxCallPayload = z.infer<typeof telnyxCallPayloadSchema>;

export {
  telnyxWebhookBodySchema,
  telnyxCallPayloadSchema,
  telnyxMachineDetectionPayloadSchema,
  telnyxWebhookEventSchema,
};

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verifies the Telnyx webhook signature using Ed25519.
 * Telnyx sends the signature in the `telnyx-signature-ed25519` header
 * and the timestamp in `telnyx-timestamp`.
 *
 * @param rawBody    - The raw request body as a string
 * @param signature  - The base64-encoded Ed25519 signature from the header
 * @param timestamp  - The timestamp string from the header
 * @param publicKey  - The Telnyx public key (base64-encoded)
 * @returns true if the signature is valid
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  timestamp: string,
  publicKey: string,
): boolean {
  try {
    const timestampedPayload = `${timestamp}|${rawBody}`;
    const decodedPublicKey = Buffer.from(publicKey, 'base64');
    const signatureBuffer = Buffer.from(signature, 'base64');

    // Build the DER-encoded Ed25519 public key
    // Ed25519 public keys are 32 bytes; DER prefix for Ed25519 is fixed
    const derPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const derKey = Buffer.concat([derPrefix, decodedPublicKey]);

    const verifier = createVerify('Ed25519');
    verifier.update(timestampedPayload);
    verifier.end();

    // Use the DER-encoded key for verification
    return verifier.verify(
      { key: derKey, format: 'der', type: 'spki' },
      signatureBuffer,
    );
  } catch (err) {
    logger.warn({ err }, 'Webhook signature verification failed with exception');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleCallInitiated(payload: TelnyxCallPayload): Promise<void> {
  const { call_control_id, from, to, direction } = payload;

  logger.info(
    { callControlId: call_control_id, from, to, direction },
    'Call initiated event received',
  );

  // Anti-loop check: prevent calling the same number within the cooldown window
  const callerNumber = direction === 'incoming' ? from : to;
  const allowed = await canCallNumber(callerNumber);

  if (!allowed) {
    logger.warn(
      { callControlId: call_control_id, callerNumber },
      'Call blocked by anti-loop cooldown — ignoring call.initiated',
    );
    return;
  }

  // Determine language/agent config from the called number
  const calledNumber = direction === 'incoming' ? to : from;
  const agentConfig = routeByPhoneNumber(calledNumber);

  // Mark that we have interacted with this number
  await markCallMade(callerNumber);

  // Create call record in the database
  await createCall({
    callId: call_control_id,
    phoneNumber: callerNumber,
    language: agentConfig.language,
  });

  incrementActiveCalls();

  logger.info(
    {
      callControlId: call_control_id,
      language: agentConfig.language,
      callerNumber,
    },
    'Call initiated — session prepared',
  );
}

async function handleCallAnswered(payload: TelnyxCallPayload): Promise<void> {
  const { call_control_id, from, to } = payload;

  logger.info(
    { callControlId: call_control_id, from, to },
    'Call answered — starting media stream',
  );

  // The actual media streaming setup happens via the WebSocket connection
  // that Telnyx establishes after we issue a streaming_start command.
  // Here we log the event for observability.
}

async function handleCallHangup(payload: TelnyxCallPayload): Promise<void> {
  const { call_control_id, from, to } = payload;

  logger.info(
    { callControlId: call_control_id, from, to },
    'Call hangup — ending session',
  );

  decrementActiveCalls();

  // Update the call record with the hangup result
  try {
    await updateCallResult({
      callId: call_control_id,
      result: 'success',
    });
  } catch (err) {
    logger.error(
      { err, callControlId: call_control_id },
      'Failed to update call result on hangup',
    );
  }

  // Persist cross-call memory for future interactions
  try {
    const callerNumber = from;
    await upsertCallMemory({
      phoneNumber: callerNumber,
      language: 'bs-BA', // Will be enriched from session context in the pipeline
      outcome: 'completed',
    });
  } catch (err) {
    logger.error(
      { err, callControlId: call_control_id },
      'Failed to upsert call memory on hangup',
    );
  }
}

async function handleMachineDetection(
  payload: z.infer<typeof telnyxMachineDetectionPayloadSchema>,
): Promise<void> {
  const { call_control_id, result } = payload;

  logger.info(
    { callControlId: call_control_id, machineResult: result },
    'Machine detection result received',
  );

  // If a machine (voicemail) was detected, mark the call accordingly
  if (result === 'machine') {
    decrementActiveCalls();

    try {
      await updateCallResult({
        callId: call_control_id,
        result: 'no_answer',
        errorLog: 'Machine/voicemail detected',
      });
    } catch (err) {
      logger.error(
        { err, callControlId: call_control_id },
        'Failed to update call result after machine detection',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Webhook route handler factory
// ---------------------------------------------------------------------------

/**
 * Creates a Fastify route handler for Telnyx webhook events.
 * Performs HMAC signature verification, Zod body validation, and
 * dispatches to the appropriate event handler.
 *
 * @returns A Fastify route handler function
 */
export function createWebhookHandler(): RouteHandlerMethod {
  return async function webhookHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // --- Signature verification ---
    const signature = request.headers['telnyx-signature-ed25519'];
    const timestamp = request.headers['telnyx-timestamp'];

    if (
      typeof signature !== 'string' ||
      typeof timestamp !== 'string' ||
      !signature ||
      !timestamp
    ) {
      logger.warn('Webhook request missing signature or timestamp headers');
      await reply.status(403).send({ error: 'Missing signature headers' });
      return;
    }

    const rawBody =
      typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body);

    const isValid = verifyWebhookSignature(
      rawBody,
      signature,
      timestamp,
      config.TELNYX_PUBLIC_KEY ?? '',
    );

    if (!isValid) {
      logger.warn(
        { signature, timestamp },
        'Webhook signature verification failed',
      );
      await reply.status(403).send({ error: 'Invalid signature' });
      return;
    }

    // --- Body validation ---
    const parseResult = telnyxWebhookBodySchema.safeParse(request.body);

    if (!parseResult.success) {
      logger.warn(
        { errors: parseResult.error.issues },
        'Webhook body validation failed',
      );
      await reply.status(400).send({ error: 'Invalid webhook body' });
      return;
    }

    const { data } = parseResult.data;
    const eventType = data.event_type;

    logger.debug(
      { eventType, eventId: data.id },
      'Processing Telnyx webhook event',
    );

    // --- Event dispatch ---
    try {
      switch (eventType) {
        case 'call.initiated': {
          const callPayload = telnyxCallPayloadSchema.parse(data.payload);
          await handleCallInitiated(callPayload);
          break;
        }

        case 'call.answered': {
          const callPayload = telnyxCallPayloadSchema.parse(data.payload);
          await handleCallAnswered(callPayload);
          break;
        }

        case 'call.hangup': {
          const callPayload = telnyxCallPayloadSchema.parse(data.payload);
          await handleCallHangup(callPayload);
          break;
        }

        case 'call.machine.detection.ended': {
          const mdPayload = telnyxMachineDetectionPayloadSchema.parse(
            data.payload,
          );
          await handleMachineDetection(mdPayload);
          break;
        }

        default:
          logger.debug({ eventType }, 'Unhandled Telnyx event type — ignoring');
          break;
      }
    } catch (err) {
      logger.error({ err, eventType }, 'Error processing webhook event');
      // Still return 200 to avoid Telnyx retries for processing errors
    }

    await reply.status(200).send({ status: 'ok' });
  };
}
