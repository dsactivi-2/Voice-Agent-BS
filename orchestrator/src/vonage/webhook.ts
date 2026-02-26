import { z } from 'zod/v4';
import type { FastifyRequest, FastifyReply, RouteHandlerMethod } from 'fastify';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Zod schemas for Vonage webhook payloads
// ---------------------------------------------------------------------------

/**
 * Vonage event webhook payload.
 * Vonage POSTs call status events (started, ringing, answered, completed, etc.)
 * to the configured event_url.
 */
const vonageEventPayloadSchema = z.object({
  uuid: z.string().min(1),
  conversation_uuid: z.string().optional(),
  status: z.string().min(1),
  direction: z.enum(['inbound', 'outbound']).optional(),
  timestamp: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  duration: z.string().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  rate: z.string().optional(),
  price: z.string().optional(),
  network: z.string().optional(),
  reason: z.string().optional(),
});

export type VonageEventPayload = z.infer<typeof vonageEventPayloadSchema>;
export { vonageEventPayloadSchema };

// ---------------------------------------------------------------------------
// NCCO (Nexmo Call Control Object) types
// ---------------------------------------------------------------------------

interface NccoWebSocketEndpoint {
  type: 'websocket';
  uri: string;
  'content-type': string;
  headers: Record<string, string>;
}

interface NccoConnectAction {
  action: 'connect';
  endpoint: NccoWebSocketEndpoint[];
}

interface NccoTalkAction {
  action: 'talk';
  text: string;
  language?: string;
}

type NccoAction = NccoConnectAction | NccoTalkAction;

// ---------------------------------------------------------------------------
// NCCO builder
// ---------------------------------------------------------------------------

/**
 * Builds the NCCO (Nexmo Call Control Object) that instructs Vonage to
 * connect the call audio to our WebSocket endpoint. The WebSocket receives
 * raw PCM audio at 16kHz 16-bit mono.
 *
 * @param callId  - The Vonage call UUID
 * @param baseUrl - The base URL of our server (e.g. 'voice.activi.io')
 * @returns An array of NCCO actions
 */
export function buildAnswerNcco(callId: string, baseUrl: string): NccoAction[] {
  const wsProtocol = 'wss';
  const wsUri = `${wsProtocol}://${baseUrl}/vonage/media`;

  return [
    {
      action: 'connect',
      endpoint: [
        {
          type: 'websocket',
          uri: wsUri,
          'content-type': 'audio/l16;rate=16000',
          headers: {
            call_id: callId,
          },
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Event handler callbacks type
// ---------------------------------------------------------------------------

export interface VonageWebhookCallbacks {
  onCallStarted?: (uuid: string, from: string, to: string) => void | Promise<void>;
  onCallAnswered?: (uuid: string, from: string, to: string) => void | Promise<void>;
  onCallCompleted?: (uuid: string, reason: string, duration: string) => void | Promise<void>;
  onCallRinging?: (uuid: string) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Answer URL handler factory (GET /vonage/answer)
// ---------------------------------------------------------------------------

/**
 * Creates a Fastify route handler for the Vonage Answer URL.
 * When Vonage connects an inbound or outbound call, it GETs this endpoint
 * and expects an NCCO JSON response that controls call flow.
 *
 * @param baseUrl - The public hostname of this server (e.g. 'voice.activi.io')
 * @returns A Fastify route handler
 */
export function createAnswerHandler(baseUrl: string): RouteHandlerMethod {
  return async function answerHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const query = request.query as Record<string, string | undefined>;
    const callId = query['uuid'] ?? query['conversation_uuid'] ?? 'unknown';
    const from = query['from'] ?? 'unknown';
    const to = query['to'] ?? 'unknown';

    logger.info(
      { callId, from, to },
      'Vonage answer URL hit — returning NCCO',
    );

    const ncco = buildAnswerNcco(callId, baseUrl);

    await reply
      .status(200)
      .header('Content-Type', 'application/json')
      .send(ncco);
  };
}

// ---------------------------------------------------------------------------
// Event URL handler factory (POST /vonage/events)
// ---------------------------------------------------------------------------

/**
 * Creates a Fastify route handler for the Vonage Event URL.
 * Vonage POSTs call status events (started, ringing, answered, completed, etc.)
 * to this endpoint throughout the call lifecycle.
 *
 * @param callbacks - Optional callbacks for specific event types
 * @returns A Fastify route handler
 */
export function createEventHandler(callbacks?: VonageWebhookCallbacks): RouteHandlerMethod {
  return async function eventHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // --- Body validation ---
    const parseResult = vonageEventPayloadSchema.safeParse(request.body);

    if (!parseResult.success) {
      logger.warn(
        { errors: parseResult.error.issues, body: request.body },
        'Vonage event body validation failed',
      );
      await reply.status(400).send({ error: 'Invalid event body' });
      return;
    }

    const event = parseResult.data;
    const { uuid, status, from, to, duration, reason } = event;

    logger.info(
      { uuid, status, from, to, duration },
      'Vonage event received',
    );

    // --- Event dispatch ---
    try {
      switch (status) {
        case 'started': {
          if (callbacks?.onCallStarted) {
            await callbacks.onCallStarted(uuid, from ?? '', to ?? '');
          }
          break;
        }

        case 'ringing': {
          if (callbacks?.onCallRinging) {
            await callbacks.onCallRinging(uuid);
          }
          break;
        }

        case 'answered': {
          if (callbacks?.onCallAnswered) {
            await callbacks.onCallAnswered(uuid, from ?? '', to ?? '');
          }
          break;
        }

        case 'completed': {
          if (callbacks?.onCallCompleted) {
            await callbacks.onCallCompleted(
              uuid,
              reason ?? 'normal',
              duration ?? '0',
            );
          }
          break;
        }

        default:
          logger.debug({ status, uuid }, 'Unhandled Vonage event status — ignoring');
          break;
      }
    } catch (err) {
      logger.error({ err, status, uuid }, 'Error processing Vonage event');
      // Still return 200 to avoid Vonage retries for processing errors
    }

    await reply.status(200).send({ status: 'ok' });
  };
}
