import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Vonage WebSocket audio frame size in bytes.
 * 640 bytes = 20 ms of Linear PCM 16-bit 16kHz mono audio.
 * Vonage requires audio to be sent in fixed-size frames; sending a single
 * large buffer causes the excess data to be silently discarded.
 */
export const VONAGE_FRAME_BYTES = 640;

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

  // ── Rate-limited audio output queue ──────────────────────────────
  // Vonage requires audio delivered at real-time rate (one 640-byte frame
  // every 20ms). Sending frames in a tight loop overflows Vonage's internal
  // buffer and causes frames to be silently discarded (words swallowed).
  private readonly audioQueue: Buffer[] = [];
  private pacerTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly FRAME_INTERVAL_MS = 20; // 20ms ≙ one 640-byte PCM frame

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
   * Enqueues raw PCM audio for rate-limited delivery to the Vonage WebSocket.
   *
   * Vonage requires audio to be delivered as individual 640-byte frames at
   * real-time rate (one frame every 20ms). Sending frames in a tight loop
   * overflows Vonage's internal buffer, causing frames to be silently
   * discarded and resulting in truncated/swallowed speech.
   *
   * This method splits `audioBuffer` into 640-byte frames and enqueues them.
   * A setInterval pacer sends one frame every 20ms, matching Vonage's
   * playback rate and preventing buffer overflow.
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

    // Split into 640-byte frames and enqueue
    for (let offset = 0; offset < audioBuffer.length; offset += VONAGE_FRAME_BYTES) {
      // Copy slice so subarray reference doesn't keep a large buffer alive
      this.audioQueue.push(Buffer.from(audioBuffer.subarray(offset, offset + VONAGE_FRAME_BYTES)));
    }

    this.startPacer();
  }

  /**
   * Clears all buffered (not yet sent) audio frames and stops the pacer.
   * Call this on barge-in so the bot stops playing immediately.
   */
  clearAudioQueue(): void {
    this.audioQueue.length = 0;
    this.stopPacer();
    logger.debug({ callId: this.callId }, 'Vonage audio queue cleared');
  }

  /**
   * Gracefully closes the WebSocket connection and stops the audio pacer.
   */
  close(): void {
    if (this.closed) return;

    this.closed = true;
    this.clearAudioQueue();

    try {
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.close(1000, 'Session ended');
      }
    } catch (err) {
      logger.error({ err, callId: this.callId }, 'Error closing Vonage WebSocket');
    }
  }

  // ── Private: rate-limited pacer ──────────────────────────────────

  private startPacer(): void {
    if (this.pacerTimer !== null) return; // already running

    this.pacerTimer = setInterval(() => {
      if (this.audioQueue.length === 0) {
        this.stopPacer();
        return;
      }

      if (!this.isOpen()) {
        this.stopPacer();
        return;
      }

      const frame = this.audioQueue.shift()!;
      try {
        this.ws.send(frame);
      } catch (err) {
        logger.error({ err, callId: this.callId }, 'Failed to send audio frame to Vonage');
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
        this.stopPacer();
      }
    }, VonageMediaSession.FRAME_INTERVAL_MS);
  }

  private stopPacer(): void {
    if (this.pacerTimer !== null) {
      clearInterval(this.pacerTimer);
      this.pacerTimer = null;
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
