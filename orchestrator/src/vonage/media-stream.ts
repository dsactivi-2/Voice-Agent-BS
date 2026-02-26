import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Event types emitted by VonageMediaSession
// ---------------------------------------------------------------------------

export interface VonageMediaStreamEvents {
  start: [info: { callId: string; contentType: string }];
  audio: [buffer: Buffer];
  stop: [info: { callId: string }];
  error: [error: Error];
}

// ---------------------------------------------------------------------------
// Vonage initial WebSocket message (JSON metadata)
// ---------------------------------------------------------------------------

/**
 * When Vonage connects a WebSocket, the first message is a JSON object
 * containing metadata about the audio format and call. Subsequent messages
 * are raw binary PCM frames (640 bytes = 20ms at 16kHz, 16-bit mono).
 */
interface VonageWebSocketMetadata {
  event?: string;
  'content-type'?: string;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// VonageMediaSession
// ---------------------------------------------------------------------------

/**
 * Manages a single Vonage media WebSocket connection. Parses the initial
 * JSON metadata message and emits raw PCM audio buffers for all subsequent
 * binary frames.
 *
 * Audio format: Linear PCM 16-bit signed, 16kHz, mono (audio/l16;rate=16000).
 * Frame size: 640 bytes (20ms of audio per frame).
 */
export class VonageMediaSession extends EventEmitter<VonageMediaStreamEvents> {
  private callId: string | null = null;
  private contentType = 'audio/l16;rate=16000';
  private metadataReceived = false;
  private readonly ws: WebSocket;
  private closed = false;
  private readonly connectedAt = Date.now();

  constructor(ws: WebSocket, initialCallId?: string) {
    super();
    this.ws = ws;
    this.callId = initialCallId ?? null;
    this.setupListeners();
  }

  /** Returns the call ID associated with this media session. */
  getCallId(): string | null {
    return this.callId;
  }

  /** Returns true if the underlying WebSocket is still open. */
  isOpen(): boolean {
    return !this.closed && this.ws.readyState === this.ws.OPEN;
  }

  /**
   * Sends raw PCM audio back to the caller via the Vonage WebSocket.
   * Vonage expects raw binary PCM frames (16kHz 16-bit mono) with no
   * additional framing or encoding.
   *
   * @param audioBuffer - Raw PCM audio buffer (16kHz 16-bit mono)
   */
  sendAudio(audioBuffer: Buffer): void {
    if (!this.isOpen()) {
      logger.warn(
        { callId: this.callId },
        'Attempted to send audio on a closed Vonage WebSocket',
      );
      return;
    }

    try {
      this.ws.send(audioBuffer);
    } catch (err) {
      logger.error(
        { err, callId: this.callId },
        'Failed to send audio frame to Vonage',
      );
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Gracefully closes the WebSocket connection.
   */
  close(): void {
    if (this.closed) return;

    this.closed = true;

    try {
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.close(1000, 'Session ended');
      }
    } catch (err) {
      logger.error({ err, callId: this.callId }, 'Error closing Vonage WebSocket');
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private setupListeners(): void {
    this.ws.binaryType = 'nodebuffer';

    this.ws.on('message', (data: Buffer | string) => {
      this.handleMessage(data);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.closed = true;
      const sessionDurationMs = Date.now() - this.connectedAt;
      logger.info(
        {
          callId: this.callId,
          code,
          reason: reason.toString('utf-8'),
          sessionDurationMs,
        },
        'Vonage media WebSocket closed',
      );

      if (this.callId) {
        this.emit('stop', { callId: this.callId });
      }
    });

    this.ws.on('error', (error: Error) => {
      logger.error(
        { err: error, callId: this.callId },
        'Vonage media WebSocket error',
      );
      this.emit('error', error);
    });
  }

  private handleMessage(data: Buffer | string): void {
    // First message from Vonage is JSON metadata about the audio stream
    if (!this.metadataReceived) {
      this.handleMetadata(data);
      return;
    }

    // All subsequent messages are raw binary PCM audio frames
    this.handleAudioFrame(data);
  }

  private handleMetadata(data: Buffer | string): void {
    try {
      const text = typeof data === 'string' ? data : data.toString('utf-8');
      const metadata = JSON.parse(text) as VonageWebSocketMetadata;

      this.metadataReceived = true;

      // Extract call_id from headers if present
      if (metadata.headers?.['call_id']) {
        this.callId = metadata.headers['call_id'];
      }

      // Extract content type
      if (metadata['content-type']) {
        this.contentType = metadata['content-type'];
      }

      const timeToFirstMessageMs = Date.now() - this.connectedAt;
      logger.info(
        {
          callId: this.callId,
          contentType: this.contentType,
          event: metadata.event,
          headers: metadata.headers,
          timeToFirstMessageMs,
        },
        'Vonage media stream metadata received',
      );

      this.emit('start', {
        callId: this.callId ?? 'unknown',
        contentType: this.contentType,
      });
    } catch (err) {
      // If parsing fails, it might be an audio frame that arrived before metadata.
      // This is unusual but we handle it gracefully by treating as metadata received.
      logger.warn(
        { err },
        'Failed to parse Vonage WebSocket metadata — treating as audio',
      );
      this.metadataReceived = true;
      this.handleAudioFrame(data);
    }
  }

  private handleAudioFrame(data: Buffer | string): void {
    try {
      const buffer = typeof data === 'string' ? Buffer.from(data, 'binary') : data;

      // Vonage sends 640-byte frames (20ms at 16kHz, 16-bit mono)
      // but we emit whatever we receive without enforcing frame size
      this.emit('audio', buffer);
    } catch (err) {
      logger.error(
        { err, callId: this.callId },
        'Failed to process Vonage audio frame',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket handler factory
// ---------------------------------------------------------------------------

/**
 * Creates a handler function for Vonage media WebSocket connections.
 * Returns a function compatible with @fastify/websocket route registration.
 *
 * @returns A function that accepts a WebSocket and creates a VonageMediaSession
 */
export function createVonageMediaStreamHandler(): (ws: WebSocket) => VonageMediaSession {
  return function vonageMediaStreamHandler(ws: WebSocket): VonageMediaSession {
    logger.info('New Vonage media WebSocket connection established');
    const session = new VonageMediaSession(ws);
    return session;
  };
}
