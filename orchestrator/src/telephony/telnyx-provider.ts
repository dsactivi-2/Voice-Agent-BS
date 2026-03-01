import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';
import { createWebhookHandler } from '../telnyx/webhook.js';
import {
  MediaStreamSession,
  createMediaStreamHandler,
} from '../telnyx/media-stream.js';
import { initiateOutboundCall as telnyxInitiateOutbound } from '../telnyx/outbound.js';
import { incrementActiveCalls, decrementActiveCalls } from '../server.js';
import type {
  TelephonyProvider,
  TelephonyEvents,
  OutboundCallParams,
} from './provider.js';
import type { Language } from '../types.js';

// ---------------------------------------------------------------------------
// TelnyxProvider
// ---------------------------------------------------------------------------

/**
 * Telnyx implementation of the TelephonyProvider interface.
 *
 * This class wraps the existing telnyx/ modules without rewriting them,
 * adapting their interfaces to the common TelephonyProvider abstraction.
 */
export class TelnyxProvider implements TelephonyProvider {
  readonly name = 'telnyx';

  /** Map of active media sessions by Telnyx call_control_id. */
  private readonly activeSessions = new Map<string, MediaStreamSession>();

  /** Event callbacks for the orchestrator. */
  private readonly events: TelephonyEvents;

  /** Media stream handler factory from the existing Telnyx module. */
  private readonly mediaStreamHandlerFn: (ws: WebSocket) => MediaStreamSession;

  constructor(events: TelephonyEvents) {
    this.events = events;
    this.mediaStreamHandlerFn = createMediaStreamHandler();
  }

  // -------------------------------------------------------------------------
  // Route registration
  // -------------------------------------------------------------------------

  registerRoutes(app: FastifyInstance): void {
    // POST /telnyx/webhook — Telnyx call event webhooks
    app.post('/telnyx/webhook', createWebhookHandler());

    // WebSocket /telnyx/media — Real-time audio streaming
    app.get('/telnyx/media', { websocket: true }, (socket, _req) => {
      this.handleMediaWebSocket(socket);
    });

    logger.info('Telnyx routes registered: /telnyx/webhook, /telnyx/media');
  }

  // -------------------------------------------------------------------------
  // Outbound call
  // -------------------------------------------------------------------------

  async initiateCall(params: OutboundCallParams): Promise<string> {
    const { phoneNumber, campaignId } = params;
    const language = (params.language ?? 'bs-BA') as Language;

    const result = await telnyxInitiateOutbound(
      phoneNumber,
      language,
      campaignId ?? 'default',
    );

    return result.callControlId;
  }

  // -------------------------------------------------------------------------
  // Send audio to an active call
  // -------------------------------------------------------------------------

  sendAudio(callId: string, audio: Buffer): void {
    const session = this.activeSessions.get(callId);

    if (!session) {
      logger.warn(
        { callId },
        'sendAudio: No active Telnyx media session found for call',
      );
      return;
    }

    session.sendAudio(audio);
  }

  // -------------------------------------------------------------------------
  // Hang up a call
  // -------------------------------------------------------------------------

  hangUp(callId: string): Promise<void> {
    const session = this.activeSessions.get(callId);

    if (session) {
      session.close();
      this.activeSessions.delete(callId);
    }

    // Telnyx hang-up is handled via the webhook/call-control API;
    // the existing webhook handler already manages hangup events.
    // For explicit hangup, we would use the Telnyx SDK:
    // await telnyx.calls.hangup(callId);
    logger.info({ callId }, 'Telnyx call session closed');
    return Promise.resolve();
  }

  // -------------------------------------------------------------------------
  // WebSocket media handler
  // -------------------------------------------------------------------------

  private handleMediaWebSocket(socket: WebSocket): void {
    logger.info('Telnyx media WebSocket connected');

    const session = this.mediaStreamHandlerFn(socket);

    session.on('start', (info) => {
      const { callControlId } = info;
      logger.info({ callControlId }, 'Telnyx media session started');
      this.activeSessions.set(callControlId, session);
      incrementActiveCalls();
    });

    session.on('audio', (buffer) => {
      const callControlId = session.getCallControlId();
      if (callControlId) {
        this.events.onAudioReceived(callControlId, buffer);
      }
    });

    session.on('stop', (_info) => {
      const callControlId = session.getCallControlId();
      if (callControlId) {
        logger.info({ callControlId }, 'Telnyx media session stopped');
        this.activeSessions.delete(callControlId);
        decrementActiveCalls();
      }
    });

    session.on('error', (error) => {
      const callControlId = session.getCallControlId();
      logger.error(
        { err: error, callControlId },
        'Telnyx media session error',
      );
      if (callControlId) {
        this.events.onError(callControlId, error);
        this.activeSessions.delete(callControlId);
      }
    });
  }
}
