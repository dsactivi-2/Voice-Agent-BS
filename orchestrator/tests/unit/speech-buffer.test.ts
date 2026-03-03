import { describe, it, expect, beforeEach } from 'vitest';
import { SpeechBuffer } from '../../src/asr/speech-buffer.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function pcmChunk(bytes: number, fill = 0x80): Buffer {
  return Buffer.alloc(bytes, fill);
}

// ── Constructor / Initial State ──────────────────────────────────────────────

describe('SpeechBuffer — initial state', () => {
  it('starts not capturing', () => {
    const sb = new SpeechBuffer();
    expect(sb.isCapturing).toBe(false);
  });

  it('starts with zero size', () => {
    const sb = new SpeechBuffer();
    expect(sb.size).toBe(0);
  });
});

// ── startCapture / addChunk / stop ───────────────────────────────────────────

describe('SpeechBuffer — capture lifecycle', () => {
  let sb: SpeechBuffer;

  beforeEach(() => {
    sb = new SpeechBuffer();
  });

  it('isCapturing is true after startCapture', () => {
    sb.startCapture();
    expect(sb.isCapturing).toBe(true);
  });

  it('addChunk accumulates bytes during capture', () => {
    sb.startCapture();
    sb.addChunk(pcmChunk(640));
    sb.addChunk(pcmChunk(640));
    expect(sb.size).toBe(1280);
  });

  it('addChunk is a no-op when not capturing', () => {
    sb.addChunk(pcmChunk(640));
    expect(sb.size).toBe(0);
  });

  it('stop returns concatenated audio', () => {
    sb.startCapture();
    const a = pcmChunk(100, 0x01);
    const b = pcmChunk(200, 0x02);
    sb.addChunk(a);
    sb.addChunk(b);

    const result = sb.stop();
    expect(result).not.toBeNull();
    expect(result!.length).toBe(300);
    expect(result!.subarray(0, 100).every((byte) => byte === 0x01)).toBe(true);
    expect(result!.subarray(100).every((byte) => byte === 0x02)).toBe(true);
  });

  it('stop returns null when no chunks were added', () => {
    sb.startCapture();
    const result = sb.stop();
    expect(result).toBeNull();
  });

  it('stop sets isCapturing to false', () => {
    sb.startCapture();
    sb.addChunk(pcmChunk(100));
    sb.stop();
    expect(sb.isCapturing).toBe(false);
  });

  it('stop resets internal state for next capture', () => {
    sb.startCapture();
    sb.addChunk(pcmChunk(500));
    sb.stop();

    expect(sb.size).toBe(0);

    // Second capture works independently
    sb.startCapture();
    sb.addChunk(pcmChunk(200, 0xff));
    const result = sb.stop();
    expect(result).not.toBeNull();
    expect(result!.length).toBe(200);
    expect(result!.every((byte) => byte === 0xff)).toBe(true);
  });
});

// ── clear ────────────────────────────────────────────────────────────────────

describe('SpeechBuffer — clear', () => {
  it('clear stops capturing and resets size', () => {
    const sb = new SpeechBuffer();
    sb.startCapture();
    sb.addChunk(pcmChunk(1000));
    sb.clear();
    expect(sb.isCapturing).toBe(false);
    expect(sb.size).toBe(0);
  });

  it('stop returns null after clear', () => {
    const sb = new SpeechBuffer();
    sb.startCapture();
    sb.addChunk(pcmChunk(500));
    sb.clear();
    const result = sb.stop();
    expect(result).toBeNull();
  });
});

// ── Max capture limit ────────────────────────────────────────────────────────

describe('SpeechBuffer — max capture limit', () => {
  it('drops chunks once 30s limit (960KB) is reached', () => {
    const sb = new SpeechBuffer();
    sb.startCapture();

    const maxBytes = 30 * 16000 * 2; // 960,000
    const chunkSize = 32000; // 1 second of audio
    const fullChunks = Math.floor(maxBytes / chunkSize); // 30

    for (let i = 0; i < fullChunks; i++) {
      sb.addChunk(pcmChunk(chunkSize));
    }
    expect(sb.size).toBe(maxBytes);

    // Next chunk should be dropped
    sb.addChunk(pcmChunk(chunkSize));
    expect(sb.size).toBe(maxBytes); // unchanged
  });

  it('allows a final chunk that fits exactly', () => {
    const sb = new SpeechBuffer();
    sb.startCapture();

    const maxBytes = 30 * 16000 * 2;
    sb.addChunk(pcmChunk(maxBytes));
    expect(sb.size).toBe(maxBytes);
  });
});

// ── startCapture resets previous state ───────────────────────────────────────

describe('SpeechBuffer — startCapture reset', () => {
  it('startCapture discards any in-progress capture', () => {
    const sb = new SpeechBuffer();
    sb.startCapture();
    sb.addChunk(pcmChunk(500, 0xaa));

    // Start a new capture without calling stop
    sb.startCapture();
    expect(sb.size).toBe(0);

    sb.addChunk(pcmChunk(200, 0xbb));
    const result = sb.stop();
    expect(result).not.toBeNull();
    expect(result!.length).toBe(200);
    expect(result!.every((byte) => byte === 0xbb)).toBe(true);
  });
});
