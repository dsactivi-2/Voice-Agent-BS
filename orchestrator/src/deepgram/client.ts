import { EventEmitter } from 'node:events';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import type { ListenLiveClient } from '@deepgram/sdk';
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

/** Raw Deepgram SDK transcript event shape (SDK types it as any). */
interface DeepgramResult {
  channel?: { alternatives?: Array<{ transcript?: string; confidence?: number }> };
  is_final?: boolean;
  speech_final?: boolean;
}

/** Exponential backoff delays for reconnect attempts (ms). */
const RECONNECT_DELAYS_MS = [500, 1000, 2000] as const;
/** Maximum reconnect attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 3;

/**
 * Streaming ASR client wrapping the official Deepgram SDK LiveClient.
 *
 * Events:
 *  - 'transcript': Fired on every partial or final transcript result.
 *  - 'error': Fired when a connection or parsing error occurs.
 *  - 'close': Fired when the connection closes.
 */
export class DeepgramASRClient extends EventEmitter<DeepgramASRClientEvents> {
  private liveClient: ListenLiveClient | null = null;
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
   * Opens a live transcription connection to Deepgram.
   * Resolves once the connection is open and ready to receive audio.
   */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.connected) {
        resolve();
        return;
      }

      logger.debug({ language: this.language }, 'Deepgram: connecting via SDK');

      const deepgram = createClient(this.apiKey);
      this.liveClient = deepgram.listen.live({
        model: 'nova-3',
        language: this.language,
        interim_results: true,
        endpointing: config.VAD_ENDPOINTING_MS,
        utterance_end_ms: 1000,
        punctuate: true,
        smart_format: true,
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1,
        // Domain-specific terms to boost recognition accuracy for job-placement calls.
        // Nova-3 uses these as hints when decoding ambiguous audio.
        keyterm: [
          // Brand names — highest priority, never in training data
          'Activi',
          'Step2Job',

          // Finance / salary
          'KM',
          'brutto',
          'netto',
          'plata',
          'plaća',
          'satnica',
          'prekovremeni',

          // Employment
          'posao',
          'zaposlenje',
          'radno mjesto',
          'ugovor',
          'probni rad',
          'otkazni rok',
          'poslodavac',
          'kvalifikacija',
          'iskustvo',

          // Documents & immigration
          'diploma',
          'Priznanje',
          'nostrifikacija',
          'viza',
          'ambasada',
          'boravak',
          'radna dozvola',
          'pasoš',
          'lična karta',
          'potvrda',

          // Housing & relocation
          'stan',
          'smještaj',
          'najam',

          // Family
          'žena',
          'supruga',
          'djeca',
          'dijeca',
          'porodica',

          // Benefits
          'godišnji odmor',
          'bolovanje',
          'zdravstveno osiguranje',
          'penzija',
        ],
      });

      this.liveClient.on(LiveTranscriptionEvents.Open, () => {
        this.connected = true;
        logger.info({ language: this.language }, 'Deepgram: WebSocket connected');
        resolve();
      });

      this.liveClient.on(LiveTranscriptionEvents.Transcript, (data) => {
        const result = data as DeepgramResult;
        const channel = result.channel;
        if (!channel) return;

        const firstAlt = channel.alternatives?.[0];
        if (!firstAlt) return;

        const transcript = firstAlt.transcript;
        if (!transcript || transcript.trim().length === 0) return;

        const isFinal = result.is_final ?? false;
        const speechFinal = result.speech_final ?? false;
        const confidence = firstAlt.confidence ?? 0;

        logger.debug(
          { transcript, isFinal, speechFinal, confidence, language: this.language },
          'Deepgram: transcript received',
        );

        this.emit('transcript', { text: transcript, isFinal, speechFinal, confidence });
      });

      this.liveClient.on(LiveTranscriptionEvents.Error, (error: Error) => {
        logger.error({ err: error, language: this.language }, 'Deepgram: connection error');

        if (!this.connected) {
          reject(error);
          return;
        }

        this.emit('error', error);
      });

      this.liveClient.on(LiveTranscriptionEvents.Close, () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.liveClient = null;

        logger.info(
          { language: this.language, closing: this.closing },
          'Deepgram: connection closed',
        );

        if (!this.closing && wasConnected) {
          this.scheduleReconnect();
        } else {
          this.emit('close', 1000, '');
        }
      });
    });
  }

  /**
   * Sends a chunk of PCM audio to Deepgram.
   * Audio must be linear16, 16kHz, mono.
   */
  sendAudio(chunk: Buffer): void {
    if (!this.liveClient || !this.connected) {
      logger.debug('Deepgram: audio dropped — not yet connected');
      return;
    }
    // Deepgram SDK expects ArrayBuffer, not Node.js Buffer
    const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    this.liveClient.send(ab as ArrayBuffer);
  }

  /**
   * Gracefully closes the Deepgram connection.
   */
  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.liveClient || this.closing) {
        this.connected = false;
        resolve();
        return;
      }

      this.closing = true;

      this.liveClient.once(LiveTranscriptionEvents.Close, () => {
        this.connected = false;
        this.closing = false;
        this.liveClient = null;
        resolve();
      });

      this.liveClient.requestClose();

      // Force-resolve after 3s to avoid hanging
      const forceTimer = setTimeout(() => {
        this.connected = false;
        this.closing = false;
        this.liveClient = null;
        resolve();
      }, 3000);
      forceTimer.unref();
    });
  }

  /** Returns whether the connection is currently open. */
  isConnected(): boolean {
    return this.connected && this.liveClient !== null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error(
        { language: this.language, attempts: this.reconnectAttempts },
        'Deepgram: max reconnect attempts reached',
      );
      this.reconnectAttempts = 0;
      this.emit(
        'error',
        new Error(`Deepgram failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts`),
      );
      return;
    }

    const delayMs = RECONNECT_DELAYS_MS[this.reconnectAttempts] ?? 2000;
    this.reconnectAttempts += 1;

    logger.info(
      { language: this.language, attempt: this.reconnectAttempts, delayMs },
      'Deepgram: scheduling reconnect',
    );

setTimeout(() => {
      void (async () => {
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
      })();
    }, delayMs);
  }
}
