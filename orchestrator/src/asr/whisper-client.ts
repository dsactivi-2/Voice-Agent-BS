import { logger } from '../utils/logger.js';

/** Supported ASR language codes. */
export type ASRLanguage = 'bs' | 'sr' | 'hr' | 'multi';

interface TranscriptionResponse {
  text: string;
}

/**
 * Prepends a 44-byte RIFF WAV header to raw PCM data.
 * Format: 16-bit signed LE, mono, 16 kHz.
 */
function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  const fileSize = 36 + dataSize;

  header.write('RIFF', 0);
  header.writeUInt32LE(fileSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

/**
 * REST-based ASR client using Whisper (Groq primary, OpenAI fallback).
 */
export class WhisperClient {
  private readonly groqApiKey: string;
  private readonly openaiApiKey: string;
  private readonly timeoutMs: number;

  constructor(groqApiKey: string, openaiApiKey: string, timeoutMs = 5000) {
    this.groqApiKey = groqApiKey;
    this.openaiApiKey = openaiApiKey;
    this.timeoutMs = timeoutMs;
    logger.info('WhisperClient created (Groq primary, OpenAI fallback)');
  }

  async transcribe(pcmAudio: Buffer, language: ASRLanguage): Promise<string> {
    const wav = pcmToWav(pcmAudio);
    const durationMs = Math.round(pcmAudio.length / 32);
    const startTime = Date.now();

    try {
      const text = await this.callWhisperAPI(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        this.groqApiKey,
        'whisper-large-v3',
        wav,
        language,
      );
      logger.info(
        { provider: 'groq', language, latencyMs: Date.now() - startTime, audioDurationMs: durationMs, textLength: text.length },
        'Whisper transcription complete',
      );
      return text;
    } catch (groqError) {
      logger.warn({ err: groqError, provider: 'groq', language }, 'Groq Whisper failed — falling back to OpenAI');
    }

    try {
      const text = await this.callWhisperAPI(
        'https://api.openai.com/v1/audio/transcriptions',
        this.openaiApiKey,
        'whisper-1',
        wav,
        language,
      );
      logger.info(
        { provider: 'openai', language, latencyMs: Date.now() - startTime, audioDurationMs: durationMs, textLength: text.length },
        'Whisper transcription complete (fallback)',
      );
      return text;
    } catch (openaiError) {
      logger.error({ err: openaiError, provider: 'openai', language }, 'OpenAI Whisper fallback also failed');
      throw openaiError;
    }
  }

  private async callWhisperAPI(
    url: string,
    apiKey: string,
    model: string,
    wavBuffer: Buffer,
    language: ASRLanguage,
  ): Promise<string> {
    // Copy to a standalone ArrayBuffer to avoid TS SharedArrayBuffer ambiguity
    const ab = new ArrayBuffer(wavBuffer.byteLength);
    new Uint8Array(ab).set(wavBuffer);

    const formData = new FormData();
    formData.append('file', new Blob([ab], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model', model);
    formData.append('language', language === 'multi' ? 'bs' : language);
    formData.append('response_format', 'json');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Whisper API ${response.status}: ${body}`);
      }

      const data = (await response.json()) as TranscriptionResponse;
      return data.text?.trim() ?? '';
    } finally {
      clearTimeout(timer);
    }
  }
}
