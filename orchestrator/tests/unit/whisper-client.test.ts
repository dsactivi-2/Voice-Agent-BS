import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WhisperClient } from '../../src/asr/whisper-client.js';

// ── Mock fetch globally ──────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Generate fake PCM audio (16kHz 16-bit mono = 32 bytes/ms). */
function fakePCM(durationMs: number): Buffer {
  return Buffer.alloc(durationMs * 32, 0x80);
}

function jsonResponse(data: object, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WhisperClient', () => {
  let client: WhisperClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new WhisperClient('groq-key-123', 'openai-key-456', 5000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Groq primary path ───────────────────────────────────────────────────

  describe('Groq primary', () => {
    it('returns transcription text from Groq', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ text: 'Zdravo, kako ste?' }));

      const result = await client.transcribe(fakePCM(1000), 'bs');

      expect(result).toBe('Zdravo, kako ste?');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
      expect(options.method).toBe('POST');
      expect(options.headers.Authorization).toBe('Bearer groq-key-123');
    });

    it('sends WAV file in multipart form data', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ text: 'test' }));

      await client.transcribe(fakePCM(500), 'bs');

      const [, options] = mockFetch.mock.calls[0];
      const body = options.body as FormData;
      expect(body).toBeInstanceOf(FormData);
      expect(body.get('model')).toBe('whisper-large-v3');
      expect(body.get('language')).toBe('bs');
      expect(body.get('response_format')).toBe('json');

      const file = body.get('file') as Blob;
      expect(file).toBeInstanceOf(Blob);
      expect(file.type).toBe('audio/wav');
    });

    it('trims whitespace from returned text', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ text: '  Dobar dan  \n' }));

      const result = await client.transcribe(fakePCM(500), 'bs');
      expect(result).toBe('Dobar dan');
    });

    it('returns empty string when text is null', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ text: null }));

      const result = await client.transcribe(fakePCM(500), 'bs');
      expect(result).toBe('');
    });
  });

  // ── Language mapping ────────────────────────────────────────────────────

  describe('language mapping', () => {
    it('maps "multi" to "bs"', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ text: 'ok' }));

      await client.transcribe(fakePCM(500), 'multi');

      const body = mockFetch.mock.calls[0][1].body as FormData;
      expect(body.get('language')).toBe('bs');
    });

    it('passes "sr" directly', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ text: 'ok' }));

      await client.transcribe(fakePCM(500), 'sr');

      const body = mockFetch.mock.calls[0][1].body as FormData;
      expect(body.get('language')).toBe('sr');
    });

    it('passes "hr" directly', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ text: 'ok' }));

      await client.transcribe(fakePCM(500), 'hr');

      const body = mockFetch.mock.calls[0][1].body as FormData;
      expect(body.get('language')).toBe('hr');
    });
  });

  // ── OpenAI fallback ─────────────────────────────────────────────────────

  describe('OpenAI fallback', () => {
    it('falls back to OpenAI when Groq returns HTTP error', async () => {
      mockFetch
        .mockResolvedValueOnce(errorResponse(503, 'Groq overloaded'))
        .mockResolvedValueOnce(jsonResponse({ text: 'Fallback works' }));

      const result = await client.transcribe(fakePCM(500), 'bs');

      expect(result).toBe('Fallback works');
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const [fallbackUrl, fallbackOptions] = mockFetch.mock.calls[1];
      expect(fallbackUrl).toBe('https://api.openai.com/v1/audio/transcriptions');
      expect(fallbackOptions.headers.Authorization).toBe('Bearer openai-key-456');

      const body = fallbackOptions.body as FormData;
      expect(body.get('model')).toBe('whisper-1');
    });

    it('falls back to OpenAI when Groq fetch throws', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(jsonResponse({ text: 'recovered' }));

      const result = await client.transcribe(fakePCM(500), 'bs');
      expect(result).toBe('recovered');
    });

    it('throws when both Groq and OpenAI fail', async () => {
      mockFetch
        .mockResolvedValueOnce(errorResponse(500, 'Groq down'))
        .mockResolvedValueOnce(errorResponse(500, 'OpenAI down'));

      await expect(client.transcribe(fakePCM(500), 'bs')).rejects.toThrow(
        'Whisper API 500',
      );
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ── WAV header ──────────────────────────────────────────────────────────

  describe('WAV header', () => {
    it('prepends a valid 44-byte RIFF WAV header', async () => {
      let capturedBody: FormData | null = null;
      mockFetch.mockImplementationOnce(async (_url: string, options: RequestInit) => {
        capturedBody = options.body as FormData;
        return jsonResponse({ text: 'ok' });
      });

      const pcm = fakePCM(100); // 3200 bytes
      await client.transcribe(pcm, 'bs');

      const file = capturedBody!.get('file') as Blob;
      const arrayBuffer = await file.arrayBuffer();
      const wav = Buffer.from(arrayBuffer);

      // Total: 44 header + 3200 PCM = 3244 bytes
      expect(wav.length).toBe(44 + 3200);

      // RIFF header
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wav.readUInt32LE(4)).toBe(36 + 3200); // file size - 8
      expect(wav.toString('ascii', 8, 12)).toBe('WAVE');

      // fmt chunk
      expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
      expect(wav.readUInt32LE(16)).toBe(16); // chunk size
      expect(wav.readUInt16LE(20)).toBe(1); // PCM format
      expect(wav.readUInt16LE(22)).toBe(1); // mono
      expect(wav.readUInt32LE(24)).toBe(16000); // sample rate
      expect(wav.readUInt32LE(28)).toBe(32000); // byte rate
      expect(wav.readUInt16LE(32)).toBe(2); // block align
      expect(wav.readUInt16LE(34)).toBe(16); // bits per sample

      // data chunk
      expect(wav.toString('ascii', 36, 40)).toBe('data');
      expect(wav.readUInt32LE(40)).toBe(3200); // data size
    });
  });

  // ── AbortController timeout ─────────────────────────────────────────────

  describe('timeout', () => {
    it('aborts fetch after configured timeout', async () => {
      // Create a client with 100ms timeout for fast test
      const fastClient = new WhisperClient('groq', 'openai', 100);

      mockFetch.mockImplementation(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            // Simulate a slow response that respects abort signal
            const signal = options.signal as AbortSignal;
            signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }),
      );

      // Both Groq and OpenAI should timeout → throws
      await expect(fastClient.transcribe(fakePCM(100), 'bs')).rejects.toThrow();
    });
  });
});
