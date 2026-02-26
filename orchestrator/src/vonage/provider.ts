import type { FastifyInstance } from 'fastify';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { createCall, updateCallResult, upsertCallMemory } from '../db/queries.js';
import { canCallNumber, markCallMade } from '../session/anti-loop.js';
import { incrementActiveCalls, decrementActiveCalls } from '../server.js';
import { VonageMediaSession } from './media-stream.js';
import {
  createAnswerHandler,
  createEventHandler,
  type VonageWebhookCallbacks,
} from './webhook.js';
import {
  initiateOutboundCall,
  hangUpCall,
} from './outbound.js';
import type {
  TelephonyProvider,
  TelephonyEvents,
  OutboundCallParams,
} from '../telephony/provider.js';

// ---------------------------------------------------------------------------
// VonageProvider
// ---------------------------------------------------------------------------

/**
 * Vonage implementation of the TelephonyProvider interface.
 *
 * Manages Vonage webhook routes (/vonage/answer, /vonage/events),
 * a WebSocket route for media streaming (/vonage/media), and
 * active call sessions.
 *
 * Audio format: Linear PCM 16-bit signed, 16kHz, mono.
 */
export class VonageProvider implements TelephonyProvider {
  readonly name = 'vonage';

  /** Map of active call sessions by Vonage UUID. */
  private readonly activeSessions = new Map<string, VonageMediaSession>();

  /** Phone number metadata for calls awaiting their media WebSocket. */
  private readonly pendingCallMeta = new Map<string, { phoneNumber: string; fromNumber: string }>();

  /** Event callbacks for the orchestrator. */
  private readonly events: TelephonyEvents;

  constructor(events: TelephonyEvents) {
    this.events = events;
  }

  // -------------------------------------------------------------------------
  // Route registration
  // -------------------------------------------------------------------------

  registerRoutes(app: FastifyInstance): void {
    const baseUrl = process.env['HOST'] ?? `localhost:${config.PORT}`;

    // GET /vonage/answer — Returns NCCO to connect call audio to WebSocket
    app.get('/vonage/answer', createAnswerHandler(baseUrl));

    // GET+POST /vonage/events — Receives call lifecycle events
    const callbacks: VonageWebhookCallbacks = {
      onCallStarted: async (uuid, from, to) => {
        await this.handleCallStarted(uuid, from, to);
      },
      onCallAnswered: async (uuid, from, to) => {
        this.handleCallAnswered(uuid, from, to);
      },
      onCallCompleted: async (uuid, reason, duration) => {
        await this.handleCallCompleted(uuid, reason, duration);
      },
      onCallRinging: (uuid) => {
        logger.debug({ uuid }, 'Vonage call ringing');
      },
    };

    const eventHandler = createEventHandler(callbacks);
    app.get('/vonage/events', eventHandler);
    app.post('/vonage/events', eventHandler);

    // WebSocket /vonage/media — Real-time audio streaming
    app.get('/vonage/media', { websocket: true }, (socket, _req) => {
      this.handleMediaWebSocket(socket);
    });

    logger.info('Vonage routes registered: /vonage/answer, /vonage/events, /vonage/media');
  }

  // -------------------------------------------------------------------------
  // Outbound call
  // -------------------------------------------------------------------------

  async initiateCall(params: OutboundCallParams): Promise<string> {
    const { phoneNumber, campaignId } = params;
    const language = (params.language ?? 'bs-BA') as 'bs-BA' | 'sr-RS';

    const result = await initiateOutboundCall(
      phoneNumber,
      language,
      campaignId ?? 'default',
    );

    return result.uuid;
  }

  // -------------------------------------------------------------------------
  // Send audio to an active call
  // -------------------------------------------------------------------------

  sendAudio(callId: string, audio: Buffer): void {
    const session = this.activeSessions.get(callId);

    if (!session) {
      logger.warn(
        { callId },
        'sendAudio: No active Vonage media session found for call',
      );
      return;
    }

    session.sendAudio(audio);
  }

  // -------------------------------------------------------------------------
  // Hang up a call
  // -------------------------------------------------------------------------

  async hangUp(callId: string): Promise<void> {
    // Close the local media session
    const session = this.activeSessions.get(callId);
    if (session) {
      session.close();
      this.activeSessions.delete(callId);
    }

    // Tell Vonage to terminate the call
    await hangUpCall(callId);
  }

  // -------------------------------------------------------------------------
  // Internal event handlers
  // -------------------------------------------------------------------------

  private async handleCallStarted(uuid: string, from: string, to: string): Promise<void> {
    // Store caller/called mapping for use when media WebSocket connects
    this.pendingCallMeta.set(uuid, { phoneNumber: from, fromNumber: to });

    logger.info(
      { uuid, from, to },
      'Vonage call started',
    );

    // Anti-loop check
    const allowed = await canCallNumber(from);
    if (!allowed) {
      logger.warn(
        { uuid, from },
        'Vonage call blocked by anti-loop cooldown',
      );
      return;
    }

    await markCallMade(from);

    // Create call record in the database
    try {
      await createCall({
        callId: uuid,
        phoneNumber: from,
        language: 'bs-BA', // Will be enriched from session context
      });
    } catch (err) {
      logger.error({ err, uuid }, 'Failed to create call record for Vonage call');
    }

    incrementActiveCalls();

    this.events.onCallStarted(uuid, from, to);
  }

  private handleCallAnswered(uuid: string, from: string, to: string): void {
    logger.info(
      { uuid, from, to },
      'Vonage call answered — media stream expected via WebSocket',
    );
  }

  private async handleCallCompleted(
    uuid: string,
    reason: string,
    duration: string,
  ): Promise<void> {
    logger.info(
      { uuid, reason, duration },
      'Vonage call completed',
    );

    // Clean up the media session
    const session = this.activeSessions.get(uuid);
    if (session) {
      session.close();
      this.activeSessions.delete(uuid);
    }

    this.pendingCallMeta.delete(uuid);

    decrementActiveCalls();

    // Update call record
    try {
      await updateCallResult({
        callId: uuid,
        result: 'success',
      });
    } catch (err) {
      logger.error({ err, uuid }, 'Failed to update call result for Vonage call');
    }

    // Persist cross-call memory
    try {
      await upsertCallMemory({
        phoneNumber: '', // Will be resolved from session context
        language: 'bs-BA',
        outcome: 'completed',
      });
    } catch (err) {
      logger.error({ err, uuid }, 'Failed to upsert call memory for Vonage call');
    }

    this.events.onCallEnded(uuid, reason);
  }

  // -------------------------------------------------------------------------
  // WebSocket media handler
  // -------------------------------------------------------------------------

  private handleMediaWebSocket(socket: import('ws').WebSocket): void {
    logger.info('Vonage media WebSocket connected');
    const wsConnectedAt = Date.now();

    const session = new VonageMediaSession(socket);

    session.on('start', (info) => {
      const { callId } = info;
      logger.info({ callId, timeToMediaReadyMs: Date.now() - wsConnectedAt }, 'Vonage media session started — firing onMediaSessionReady');
      this.activeSessions.set(callId, session);

      // Fire onMediaSessionReady so server.ts can create the CallOrchestrator
      const meta = this.pendingCallMeta.get(callId) ?? { phoneNumber: 'unknown', fromNumber: 'unknown' };
      if (this.events.onMediaSessionReady) {
        this.events.onMediaSessionReady(
          callId,
          session as unknown as import('../telephony/provider.js').MediaSession,
          meta,
        );
      }
    });

    session.on('stop', (info) => {
      const { callId } = info;
      logger.info({ callId }, 'Vonage media session stopped');
      this.activeSessions.delete(callId);
      decrementActiveCalls();
    });

    session.on('error', (error) => {
      const callId = session.getCallId();
      logger.error(
        { err: error, callId },
        'Vonage media session error',
      );
      if (callId) {
        this.events.onError(callId, error);
        this.activeSessions.delete(callId);
      }
    });
  }
}
