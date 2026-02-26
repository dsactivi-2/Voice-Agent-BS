import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Outbound call parameters
// ---------------------------------------------------------------------------

export interface OutboundCallParams {
  phoneNumber: string;
  fromNumber: string;
  webhookUrl: string;
  streamUrl: string;
  campaignId?: string;
  language?: string;
}

// ---------------------------------------------------------------------------
// Telephony event callbacks
// ---------------------------------------------------------------------------

/**
 * Minimal interface shared by all media session implementations
 * (Telnyx MediaStreamSession, Vonage VonageMediaSession, etc.).
 * Both emit: 'audio' (Buffer), 'stop' (any), 'error' (Error)
 */
export interface MediaSession {
  sendAudio(buffer: Buffer): void;
  isOpen(): boolean;
  close(): void;
  on(event: 'audio', listener: (buffer: Buffer) => void): this;
  on(event: 'stop', listener: (info?: unknown) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  off(event: 'audio', listener: (buffer: Buffer) => void): this;
  off(event: 'stop', listener: (info?: unknown) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
}

export interface TelephonyEvents {
  onCallStarted: (callId: string, phoneNumber: string, fromNumber: string) => void;
  onCallEnded: (callId: string, reason: string) => void;
  onAudioReceived: (callId: string, audio: Buffer) => void;
  onError: (callId: string, error: Error) => void;
  onMediaSessionReady?: (
    callId: string,
    session: MediaSession,
    meta: { phoneNumber: string; fromNumber: string },
  ) => void;
}

// ---------------------------------------------------------------------------
// Abstract telephony provider interface
// ---------------------------------------------------------------------------

/**
 * Common interface that all telephony providers (Telnyx, Vonage, etc.) must
 * implement. This allows the rest of the system to remain provider-agnostic
 * while supporting multiple carriers for redundancy and regional coverage.
 */
export interface TelephonyProvider {
  /** Human-readable provider name (e.g. 'telnyx', 'vonage'). */
  readonly name: string;

  /**
   * Register webhook and WebSocket routes on the Fastify application.
   * Each provider owns its own URL namespace (e.g. /telnyx/*, /vonage/*).
   */
  registerRoutes(app: FastifyInstance): void;

  /**
   * Initiate an outbound call through this provider.
   * @returns The provider-specific call ID (call_control_id for Telnyx, uuid for Vonage).
   */
  initiateCall(params: OutboundCallParams): Promise<string>;

  /**
   * Send raw PCM audio (16kHz 16-bit mono) to an active call.
   * The provider is responsible for encoding/framing as required by its API.
   */
  sendAudio(callId: string, audio: Buffer): void;

  /**
   * Hang up an active call.
   */
  hangUp(callId: string): Promise<void>;
}
