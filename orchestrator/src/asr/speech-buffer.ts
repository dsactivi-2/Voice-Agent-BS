import { logger } from '../utils/logger.js';

/** Maximum capture duration: 30 seconds at 16kHz 16-bit mono = 960 KB. */
const MAX_CAPTURE_BYTES = 30 * 16000 * 2;

/**
 * Accumulates PCM audio chunks during a speech segment.
 */
export class SpeechBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  private capturing = false;

  get isCapturing(): boolean {
    return this.capturing;
  }

  get size(): number {
    return this.totalBytes;
  }

  startCapture(): void {
    this.chunks = [];
    this.totalBytes = 0;
    this.capturing = true;
  }

  addChunk(chunk: Buffer): void {
    if (!this.capturing) return;

    if (this.totalBytes + chunk.length > MAX_CAPTURE_BYTES) {
      logger.warn(
        { totalBytes: this.totalBytes, maxBytes: MAX_CAPTURE_BYTES },
        'SpeechBuffer: max capture size reached, dropping chunk',
      );
      return;
    }

    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
  }

  stop(): Buffer | null {
    this.capturing = false;

    if (this.chunks.length === 0) {
      return null;
    }

    const result = Buffer.concat(this.chunks, this.totalBytes);
    this.chunks = [];
    this.totalBytes = 0;

    logger.debug(
      { bytes: result.length, durationMs: Math.round(result.length / 32) },
      'SpeechBuffer: capture stopped',
    );
    return result;
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
    this.capturing = false;
  }
}
