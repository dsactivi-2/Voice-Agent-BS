import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { synthesizeSpeech } from './azure-client.js';
import { getCachedAudio, setCachedAudio } from './cache.js';
import { cleanForTTS } from './clean.js';
import type { Language } from '../types.js';

/** Only sentence-ending punctuation triggers a chunk flush.
 * Commas, dashes, and ellipsis intentionally excluded — they cause
 * unnatural pauses in mid-sentence speech. */
const CHUNK_TRIGGERS = ['.', '!', '?'] as const;

/** Minimum character count before a chunk is eligible for flushing.
 * Set high enough to avoid sending tiny fragments to Azure TTS. */
const MIN_CHUNK_LENGTH = 40;

/** Maximum milliseconds to wait before forcing a flush.
 * Reduced to keep latency reasonable for very long sentences. */
const MAX_WAIT_MS = 500;

/** Callback type for receiving synthesized PCM audio chunks. */
export type AudioChunkCallback = (audio: Buffer, text: string) => void;

/**
 * Events emitted by {@link ChunkedTTSPipeline}.
 */
export interface ChunkedTTSPipelineEvents {
  chunkReady: [text: string];
  audioReady: [audio: Buffer, text: string];
  error: [error: Error, text: string];
  done: [];
}

/**
 * Determines whether the accumulated buffer should be flushed for TTS synthesis.
 *
 * The buffer is flushed when:
 * 1. It exceeds {@link MIN_CHUNK_LENGTH} AND ends with a sentence-ending trigger character (.!?), OR
 * 2. It exceeds {@link MIN_CHUNK_LENGTH} AND the wait time has exceeded {@link MAX_WAIT_MS}.
 *
 * @param buffer     - The currently accumulated token buffer
 * @param waitTimeMs - Milliseconds elapsed since the last flush or pipeline start
 * @returns true if the buffer should be flushed
 */
export function shouldFlushChunk(buffer: string, waitTimeMs: number): boolean {
  if (buffer.length < MIN_CHUNK_LENGTH) return false;

  const trimmed = buffer.trimEnd();
  if (CHUNK_TRIGGERS.some((t) => trimmed.endsWith(t))) return true;
  if (waitTimeMs >= MAX_WAIT_MS) return true;

  return false;
}

/**
 * Generates a deterministic cache key from text, language, and voice parameters.
 */
function cacheKey(text: string, language: Language, voice: string): string {
  const hash = createHash('sha256')
    .update(`${language}:${voice}:${text}`)
    .digest('hex')
    .slice(0, 24);
  return `chunk:${hash}`;
}

/**
 * Chunked TTS pipeline that accumulates streaming LLM tokens, detects
 * sentence boundaries, and synthesizes each chunk independently via Azure TTS.
 *
 * Pipeline flow:
 *   LLM tokens --> buffer --> chunk detection --> cache check --> Azure TTS --> audio callback
 *
 * The pipeline emits events at each stage so callers can observe progress
 * without tight coupling to the internal processing.
 *
 * @example
 * ```ts
 * const pipeline = new ChunkedTTSPipeline('bs-BA', undefined, (audio, text) => {
 *   sendToTelephony(audio);
 * });
 *
 * for await (const token of llmStream) {
 *   pipeline.addTokens(token);
 * }
 * await pipeline.flush();
 * ```
 */
export class ChunkedTTSPipeline extends EventEmitter<ChunkedTTSPipelineEvents> {
  private buffer = '';
  private lastFlushAt: number;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private pendingSyntheses: Promise<void>[] = [];

  private readonly language: Language;
  private readonly voice: string;
  private readonly onAudioChunk: AudioChunkCallback;

  /**
   * @param language     - Target language for TTS synthesis
   * @param voice        - Azure Neural voice name; if omitted, the default for the language is used
   * @param onAudioChunk - Callback invoked with each synthesized PCM audio buffer
   */
  constructor(
    language: Language,
    voice: string | undefined,
    onAudioChunk: AudioChunkCallback,
  ) {
    super();
    this.language = language;
    // When voice is undefined, synthesizeSpeech will resolve the default internally
    this.voice = voice ?? '';
    this.onAudioChunk = onAudioChunk;
    this.lastFlushAt = Date.now();
  }

  /**
   * Accumulates incoming LLM tokens into the internal buffer. When the buffer
   * meets chunk criteria (sentence-ending punctuation or timeout), it is
   * automatically flushed for synthesis.
   *
   * @param tokens - One or more token characters from the LLM stream
   */
  addTokens(tokens: string): void {
    if (this.destroyed) return;

    this.buffer += tokens;

    const elapsed = Date.now() - this.lastFlushAt;

    if (shouldFlushChunk(this.buffer, elapsed)) {
      this.flushBuffer();
    } else {
      // Schedule a forced flush after MAX_WAIT_MS if no natural boundary arrives
      this.resetFlushTimer();
    }
  }

  /**
   * Forces any remaining buffered text to be synthesized. Call this when
   * the LLM stream has ended to ensure the final partial sentence is spoken.
   *
   * Waits for all in-flight synthesis requests to complete before resolving.
   */
  async flush(): Promise<void> {
    if (this.destroyed) return;

    this.clearFlushTimer();

    if (this.buffer.trim().length > 0) {
      this.flushBuffer();
    }

    // Wait for all pending synthesis tasks to settle
    await Promise.allSettled(this.pendingSyntheses);
    this.pendingSyntheses = [];

    this.emit('done');
  }

  /**
   * Tears down the pipeline, clearing all timers and preventing further processing.
   */
  destroy(): void {
    this.destroyed = true;
    this.clearFlushTimer();
    this.buffer = '';
    this.pendingSyntheses = [];
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Extracts the current buffer contents and submits the text for synthesis.
   */
  private flushBuffer(): void {
    const raw = this.buffer.trim();
    this.buffer = '';
    this.lastFlushAt = Date.now();
    this.clearFlushTimer();

    const text = cleanForTTS(raw);

    if (text.length === 0) return;

    this.emit('chunkReady', text);

    // This self-cleaning pattern prevents settled Promises from accumulating in the
    // array indefinitely under load — fixing the memory leak in long calls.
    // We push first so the reference is valid inside finally().
    const synthesisTaskHolder: { task: Promise<void> | null } = { task: null };
    const synthesisTask = this.synthesizeChunk(text).finally(() => {
      const idx = synthesisTaskHolder.task
        ? this.pendingSyntheses.indexOf(synthesisTaskHolder.task)
        : -1;
      if (idx !== -1) void this.pendingSyntheses.splice(idx, 1);
    });
    synthesisTaskHolder.task = synthesisTask;
    this.pendingSyntheses.push(synthesisTask);
  }

  /**
   * Synthesizes a single text chunk, checking the Redis cache first.
   * On cache miss the chunk is sent to Azure TTS and the result is cached.
   */
  private async synthesizeChunk(text: string): Promise<void> {
    if (this.destroyed) return;

    const key = cacheKey(text, this.language, this.voice);

    try {
      // Check cache first
      const cached = await getCachedAudio(key);
      if (cached !== null) {
        logger.debug({ text: text.slice(0, 40), key }, 'TTS chunk served from cache');
        this.deliverAudio(cached, text);
        return;
      }

      // Synthesize via Azure
      const voiceArg = this.voice.length > 0 ? this.voice : undefined;
      const audio = await synthesizeSpeech(text, this.language, voiceArg);


      // Cache the result (fire-and-forget, errors are logged inside setCachedAudio)
      setCachedAudio(key, audio).catch((err: unknown) => {
        logger.warn({ err, key }, 'Failed to cache TTS chunk audio');
      });

      this.deliverAudio(audio, text);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error({ err, text: text.slice(0, 40) }, 'TTS chunk synthesis failed');
      this.emit('error', error, text);
    }
  }

  /**
   * Delivers synthesized audio to the callback and emits the audioReady event.
   */
  private deliverAudio(audio: Buffer, text: string): void {
    if (this.destroyed) return;

    this.onAudioChunk(audio, text);
    this.emit('audioReady', audio, text);
  }

  /**
   * Resets the MAX_WAIT_MS timer so a flush is forced if no natural boundary
   * appears within the timeout window.
   */
  private resetFlushTimer(): void {
    this.clearFlushTimer();
    this.flushTimer = setTimeout(() => {
      if (!this.destroyed && this.buffer.trim().length > 0) {
        this.flushBuffer();
      }
    }, MAX_WAIT_MS);
  }

  /**
   * Clears the pending flush timer if one exists.
   */
  private clearFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

export { MIN_CHUNK_LENGTH, MAX_WAIT_MS, CHUNK_TRIGGERS };
