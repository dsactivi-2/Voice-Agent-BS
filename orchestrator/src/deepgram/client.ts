import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** Deepgram language codes for Bosnian and Serbian. */
export type DeepgramLanguage = 'bs' | 'sr';

export interface DeepgramTranscriptEvent {
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  confidence: number;
}

export interface DeepgramASRClientEvents {
  transcript: [event: DeepgramTranscriptEvent];
  error: [error: Error];
  close: [code: number, reason: string];
  reconnected: [];
}

/**
 * Represents a single Deepgram transcript alternative returned in the API response.
 */
interface DeepgramAlternative {
  transcript: string;
  confidence: number;
}

/**
 * Represents a single channel result from the Deepgram streaming response.
 */
interface DeepgramChannel {
  alternatives: DeepgramAlternative[];
}

/**
 * The streaming transcription response received over the Deepgram WebSocket.
 */
interface DeepgramStreamingResponse {
  type: string;
  channel?: {
    alternatives: DeepgramAlternative[];
  };
  is_final?: boolean;
  speech_final?: boolean;
  channel_index?: number[];
}

/**
 * Streaming ASR client that communicates with Deepgram's Live Transcription API
 * over a WebSocket connection.
 *
 * Events:
 *  - 'transcript': Fired on every partial or final transcript result.
 *  - 'error': Fired when a WebSocket or parsing error occurs.
 *  - 'close': Fired when the WebSocket connection closes.
 */
/** Exponential backoff delays for reconnect attempts (ms). */
const RECONNECT_DELAYS_MS = [500, 1000, 2000] as const;
/** Maximum reconnect attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 3;

export class DeepgramASRClient extends EventEmitter<DeepgramASRClientEvents> {
  private ws: WebSocket | null = null;
  private readonly language: DeepgramLanguage;
  private readonly apiKey: string;
  private connected = false;
  private closing = false;
  private reconnectAttempts = 0;

  constructor(language: DeepgramLanguage, apiKey: string) {
    super();
    this.language = language;
    this.apiKey = apiKey;

    logger.debug({ language }, 'DeepgramASRClient created');
  }

  /**
   * Opens a WebSocket connection to the Deepgram Live Transcription API.
   * Resolves once the connection is established and ready to receive audio.
   */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.connected) {
        resolve();
        return;
      }

      const params = new URLSearchParams({
        model: 'nova-3',
        language: this.language,
        interim_results: 'true',
        endpointing: String(config.VAD_ENDPOINTING_MS),
        utterance_end_ms: '1000',
        punctuate: 'true',
        smart_format: 'true',
        encoding: 'linear16',
        sample_rate: '16000',
        channels: '1',
      });

      const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

      logger.debug({ url, language: this.language }, 'Deepgram: connecting to WebSocket');

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Token ${this.apiKey}`,
        },
      });

      this.ws.on('open', () => {
        this.connected = true;
        logger.info({ language: this.language }, 'Deepgram: WebSocket connected');
        resolve();
      });

      this.ws.on('message', (data: Buffer | string) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error: Error) => {
        logger.error({ err: error, language: this.language }, 'Deepgram: WebSocket error');

        if (!this.connected) {
          reject(error);
          return;
        }

        this.emit('error', error);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason.toString();
        this.connected = false;
        this.ws = null;

        logger.info(
          { code, reason: reasonStr, language: this.language, closing: this.closing },
          'Deepgram: WebSocket closed',
        );

        // Only reconnect on unexpected closes (not initiated by close() call)
        if (!this.closing) {
          this.scheduleReconnect();
        } else {
          this.emit('close', code, reasonStr);
        }
      });
    });
  }

  /**
   * Sends a chunk of PCM audio data to Deepgram for transcription.
   * The audio must be linear16, 16kHz, mono.
   *
   * @param chunk - Raw PCM audio buffer to send
   */
  sendAudio(chunk: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('Deepgram: attempted to send audio on a closed WebSocket');
      return;
    }

    this.ws.send(chunk);
  }

  /**
   * Gracefully closes the Deepgram WebSocket connection.
   * Sends a CloseStream message to signal Deepgram to finalize any pending
   * transcription before closing.
   */
  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.ws || this.closing) {
        this.connected = false;
        resolve();
        return;
      }

      this.closing = true;

      // Send Deepgram's close signal: an empty byte buffer
      // per Deepgram docs, sending a zero-length buffer or a CloseStream JSON message
      // signals the server to finalize and close.
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
      } catch {
        // Ignore send errors during close
      }

      const onClose = () => {
        this.connected = false;
        this.closing = false;
        this.ws = null;
        resolve();
      };

      // If the WebSocket is already closed, resolve immediately
      if (this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
        onClose();
        return;
      }

      this.ws.once('close', onClose);

      // Force close after a short timeout to prevent hanging
      const forceCloseTimer = setTimeout(() => {
        if (this.ws) {
          this.ws.removeListener('close', onClose);
          this.ws.terminate();
          onClose();
        }
      }, 3000);

      // Prevent the timer from keeping the process alive
      forceCloseTimer.unref();

      this.ws.close();
    });
  }

  /**
   * Attempts to reconnect with exponential backoff.
   * Emits 'error' after MAX_RECONNECT_ATTEMPTS failures.
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error(
        { language: this.language, attempts: this.reconnectAttempts },
        'Deepgram: max reconnect attempts reached',
      );
      this.reconnectAttempts = 0;
      this.emit('error', new Error(
        `Deepgram WebSocket failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts`,
      ));
      return;
    }

    const delayMs = RECONNECT_DELAYS_MS[this.reconnectAttempts] ?? 2000;
    this.reconnectAttempts += 1;

    logger.info(
      { language: this.language, attempt: this.reconnectAttempts, delayMs },
      'Deepgram: scheduling reconnect',
    );

    setTimeout(async () => {
      if (this.closing) return;
      try {
        await this.connect();
        this.reconnectAttempts = 0;
        logger.info({ language: this.language }, 'Deepgram: reconnected successfully');
        this.emit('reconnected');
      } catch (error) {
        logger.warn(
          { err: error, language: this.language, attempt: this.reconnectAttempts },
          'Deepgram: reconnect attempt failed',
        );
        this.scheduleReconnect();
      }
    }, delayMs);
  }

  /** Returns whether the WebSocket connection is currently open. */
  isConnected(): boolean {
    return this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Parses an incoming Deepgram WebSocket message and emits the
   * appropriate transcript event.
   */
  private handleMessage(data: Buffer | string): void {
    try {
      const raw = typeof data === 'string' ? data : data.toString('utf-8');
      const response = JSON.parse(raw) as DeepgramStreamingResponse;

      // Only process Results messages
      if (response.type !== 'Results') {
        logger.trace({ type: response.type }, 'Deepgram: non-transcript message received');
        return;
      }

      const channel = response.channel;
      if (!channel) {
        return;
      }

      const firstAlternative = channel.alternatives[0];
      if (!firstAlternative) {
        return;
      }

      const transcript = firstAlternative.transcript;

      // Skip empty transcripts (silence / no speech detected)
      if (!transcript || transcript.trim().length === 0) {
        return;
      }

      const isFinal = response.is_final ?? false;
      const speechFinal = response.speech_final ?? false;
      const confidence = firstAlternative.confidence;

      logger.debug(
        {
          transcript,
          isFinal,
          speechFinal,
          confidence,
          language: this.language,
        },
        'Deepgram: transcript received',
      );

      this.emit('transcript', {
        text: transcript,
        isFinal,
        speechFinal,
        confidence,
      });
    } catch (error) {
      logger.error(
        { err: error, language: this.language },
        'Deepgram: failed to parse WebSocket message',
      );
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }
}
