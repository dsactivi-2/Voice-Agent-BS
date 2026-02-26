import { EventEmitter } from 'node:events';
import { z } from 'zod/v4';
import type { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Zod schemas for Telnyx WebSocket messages
// ---------------------------------------------------------------------------

const telnyxMediaStartSchema = z.object({
  event: z.literal('start'),
  stream_id: z.string().min(1),
  call_control_id: z.string().min(1),
  media_format: z
    .object({
      encoding: z.string().optional(),
      sample_rate: z.number().optional(),
      channels: z.number().optional(),
    })
    .optional(),
});

const telnyxMediaDataSchema = z.object({
  event: z.literal('media'),
  stream_id: z.string().min(1),
  payload: z.string().min(1), // base64-encoded PCM audio
  sequence_number: z.number().optional(),
});

const telnyxMediaStopSchema = z.object({
  event: z.literal('stop'),
  stream_id: z.string().min(1),
  call_control_id: z.string().optional(),
});

const telnyxWebSocketMessageSchema = z.discriminatedUnion('event', [
  telnyxMediaStartSchema,
  telnyxMediaDataSchema,
  telnyxMediaStopSchema,
]);

export type TelnyxMediaStart = z.infer<typeof telnyxMediaStartSchema>;
export type TelnyxMediaData = z.infer<typeof telnyxMediaDataSchema>;
export type TelnyxMediaStop = z.infer<typeof telnyxMediaStopSchema>;
export type TelnyxWebSocketMessage = z.infer<typeof telnyxWebSocketMessageSchema>;

export {
  telnyxMediaStartSchema,
  telnyxMediaDataSchema,
  telnyxMediaStopSchema,
  telnyxWebSocketMessageSchema,
};

// ---------------------------------------------------------------------------
// Event types emitted by the media stream handler
// ---------------------------------------------------------------------------

export interface MediaStreamEvents {
  start: [info: { streamId: string; callControlId: string }];
  audio: [buffer: Buffer];
  stop: [info: { streamId: string }];
  error: [error: Error];
}

// ---------------------------------------------------------------------------
// MediaStreamSession
// ---------------------------------------------------------------------------

/**
 * Wraps a single Telnyx media WebSocket connection, parsing incoming
 * audio frames and providing an EventEmitter interface for the rest
 * of the pipeline to subscribe to.
 */
export class MediaStreamSession extends EventEmitter<MediaStreamEvents> {
  private streamId: string | null = null;
  private callControlId: string | null = null;
  private readonly ws: WebSocket;
  private closed = false;

  constructor(ws: WebSocket) {
    super();
    this.ws = ws;
    this.setupListeners();
  }

  /** Returns the current stream ID, or null if the stream has not started. */
  getStreamId(): string | null {
    return this.streamId;
  }

  /** Returns the call control ID associated with this stream. */
  getCallControlId(): string | null {
    return this.callControlId;
  }

  /** Returns true if the underlying WebSocket is still open. */
  isOpen(): boolean {
    return !this.closed && this.ws.readyState === this.ws.OPEN;
  }

  /**
   * Sends a PCM audio buffer back to the caller via the Telnyx WebSocket.
   * The buffer is base64-encoded and wrapped in the Telnyx media message format.
   *
   * @param audioBuffer - Raw PCM audio buffer (16kHz 16-bit mono)
   */
  sendAudio(audioBuffer: Buffer): void {
    if (!this.isOpen()) {
      logger.warn(
        { streamId: this.streamId },
        'Attempted to send audio on a closed WebSocket',
      );
      return;
    }

    if (!this.streamId) {
      logger.warn('Attempted to send audio before stream start event');
      return;
    }

    const message = JSON.stringify({
      event: 'media',
      stream_id: this.streamId,
      payload: audioBuffer.toString('base64'),
    });

    try {
      this.ws.send(message);
    } catch (err) {
      logger.error(
        { err, streamId: this.streamId },
        'Failed to send audio frame to Telnyx',
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
      logger.error({ err, streamId: this.streamId }, 'Error closing WebSocket');
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private setupListeners(): void {
    this.ws.on('message', (data: Buffer | string) => {
      this.handleMessage(data);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.closed = true;
      logger.info(
        {
          streamId: this.streamId,
          code,
          reason: reason.toString('utf-8'),
        },
        'Telnyx media WebSocket closed',
      );

      if (this.streamId) {
        this.emit('stop', { streamId: this.streamId });
      }
    });

    this.ws.on('error', (error: Error) => {
      logger.error(
        { err: error, streamId: this.streamId },
        'Telnyx media WebSocket error',
      );
      this.emit('error', error);
    });
  }

  private handleMessage(data: Buffer | string): void {
    let parsed: unknown;

    try {
      const text = typeof data === 'string' ? data : data.toString('utf-8');
      parsed = JSON.parse(text);
    } catch (err) {
      logger.warn(
        { err },
        'Failed to parse incoming WebSocket message as JSON',
      );
      return;
    }

    const result = telnyxWebSocketMessageSchema.safeParse(parsed);

    if (!result.success) {
      logger.debug(
        { issues: result.error.issues },
        'Received unrecognised WebSocket message — ignoring',
      );
      return;
    }

    const message = result.data;

    switch (message.event) {
      case 'start':
        this.handleStart(message);
        break;
      case 'media':
        this.handleMedia(message);
        break;
      case 'stop':
        this.handleStop(message);
        break;
    }
  }

  private handleStart(message: TelnyxMediaStart): void {
    this.streamId = message.stream_id;
    this.callControlId = message.call_control_id;

    logger.info(
      {
        streamId: this.streamId,
        callControlId: this.callControlId,
        mediaFormat: message.media_format,
      },
      'Telnyx media stream started',
    );

    this.emit('start', {
      streamId: this.streamId,
      callControlId: this.callControlId,
    });
  }

  private handleMedia(message: TelnyxMediaData): void {
    try {
      const audioBuffer = Buffer.from(message.payload, 'base64');
      this.emit('audio', audioBuffer);
    } catch (err) {
      logger.error(
        { err, streamId: this.streamId },
        'Failed to decode base64 audio payload',
      );
    }
  }

  private handleStop(message: TelnyxMediaStop): void {
    logger.info(
      { streamId: message.stream_id },
      'Telnyx media stream stop event received',
    );

    this.emit('stop', { streamId: message.stream_id });
  }
}

// ---------------------------------------------------------------------------
// Standalone helper function
// ---------------------------------------------------------------------------

/**
 * Encodes a raw PCM audio buffer and sends it to the caller via a
 * Telnyx media WebSocket connection. This is a convenience wrapper
 * for use outside the MediaStreamSession class.
 *
 * @param ws          - The raw WebSocket connection to Telnyx
 * @param audioBuffer - Raw PCM audio (16kHz 16-bit mono)
 * @param streamId    - The Telnyx stream ID to target
 */
export function sendAudioToTelnyx(
  ws: WebSocket,
  audioBuffer: Buffer,
  streamId: string,
): void {
  if (ws.readyState !== ws.OPEN) {
    logger.warn(
      { streamId },
      'sendAudioToTelnyx: WebSocket is not open — dropping audio frame',
    );
    return;
  }

  const message = JSON.stringify({
    event: 'media',
    stream_id: streamId,
    payload: audioBuffer.toString('base64'),
  });

  try {
    ws.send(message);
  } catch (err) {
    logger.error(
      { err, streamId },
      'sendAudioToTelnyx: Failed to send audio frame',
    );
  }
}

// ---------------------------------------------------------------------------
// WebSocket handler factory
// ---------------------------------------------------------------------------

/**
 * Creates a WebSocket handler for Telnyx media streaming.
 * Returns a function compatible with @fastify/websocket route registration.
 *
 * @returns A function that accepts a WebSocket and creates a MediaStreamSession
 */
export function createMediaStreamHandler(): (ws: WebSocket) => MediaStreamSession {
  return function mediaStreamHandler(ws: WebSocket): MediaStreamSession {
    logger.info('New Telnyx media WebSocket connection established');
    const session = new MediaStreamSession(ws);
    return session;
  };
}
