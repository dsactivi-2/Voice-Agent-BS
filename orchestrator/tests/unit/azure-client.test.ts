import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Language } from '../../src/types.js';

// Mock logger before importing the module under test
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock config with test values
vi.mock('../../src/config.js', () => ({
  config: {
    AZURE_SPEECH_KEY: 'test-speech-key',
    AZURE_REGION: 'westeurope',
    TTS_VOICE_BS: 'bs-BA-GoranNeural',
    TTS_VOICE_SR: 'sr-RS-NicholasNeural',
    TTS_CACHE_TTL_SECONDS: 86400,
  },
}));

// Mock retry to execute immediately without delays
vi.mock('../../src/utils/retry.js', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

// Create mock synthesizer instance
const mockSpeakSsmlAsync = vi.fn();
const mockClose = vi.fn();

// Mock the entire Azure Speech SDK
vi.mock('microsoft-cognitiveservices-speech-sdk', () => {
  const mockSpeechConfig = {
    speechSynthesisOutputFormat: 0,
  };

  // Must use a real function (not arrow) so it can be called with `new`
  function MockSpeechSynthesizer() {
    return {
      speakSsmlAsync: mockSpeakSsmlAsync,
      close: mockClose,
    };
  }

  return {
    SpeechConfig: {
      fromSubscription: vi.fn(() => mockSpeechConfig),
    },
    SpeechSynthesizer: MockSpeechSynthesizer,
    SpeechSynthesisOutputFormat: {
      Raw16Khz16BitMonoPcm: 14,
    },
    ResultReason: {
      SynthesizingAudioCompleted: 8,
      Canceled: 1,
    },
    SpeechSynthesisResult: {
      prototype: {},
    },
  };
});

describe('buildSSML', () => {
  let buildSSML: (text: string, language: Language, voice: string) => string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../src/tts/azure-client.js');
    buildSSML = mod.buildSSML;
  });

  it('generates valid SSML with correct language and voice', () => {
    const ssml = buildSSML('Dobar dan', 'bs-BA', 'bs-BA-GoranNeural');

    expect(ssml).toContain('xml:lang="bs-BA"');
    expect(ssml).toContain('name="bs-BA-GoranNeural"');
    expect(ssml).toContain('Dobar dan');
    expect(ssml).toContain('<speak version="1.0"');
    expect(ssml).toContain('</speak>');
  });

  it('includes prosody tags with correct rate and pitch', () => {
    const ssml = buildSSML('Test tekst', 'sr-RS', 'sr-RS-NicholasNeural');

    expect(ssml).toContain('rate="+3%"');
    expect(ssml).toContain('pitch="+1%"');
    expect(ssml).toContain('<prosody');
    expect(ssml).toContain('</prosody>');
  });

  it('includes mstts express-as customerservice style', () => {
    const ssml = buildSSML('Hvala', 'bs-BA', 'bs-BA-GoranNeural');

    expect(ssml).toContain('xmlns:mstts="http://www.w3.org/2001/mstts"');
    expect(ssml).toContain('<mstts:express-as style="customerservice">');
    expect(ssml).toContain('</mstts:express-as>');
  });

  it('escapes XML special characters in text', () => {
    const ssml = buildSSML('Cijena < 100 & popust > 5%', 'bs-BA', 'bs-BA-GoranNeural');

    expect(ssml).toContain('&lt;');
    expect(ssml).toContain('&amp;');
    expect(ssml).toContain('&gt;');
    expect(ssml).not.toContain('< 100');
    expect(ssml).not.toContain('> 5');
  });

  it('generates correct SSML for sr-RS language', () => {
    const ssml = buildSSML('Kako ste?', 'sr-RS', 'sr-RS-NicholasNeural');

    expect(ssml).toContain('xml:lang="sr-RS"');
    expect(ssml).toContain('name="sr-RS-NicholasNeural"');
    expect(ssml).toContain('Kako ste?');
  });
});

describe('synthesizeSpeech', () => {
  let synthesizeSpeech: (text: string, language: Language, voice?: string) => Promise<Buffer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../src/tts/azure-client.js');
    synthesizeSpeech = mod.synthesizeSpeech;
  });

  it('calls Azure SDK and returns audio buffer on success', async () => {
    const fakeAudio = new ArrayBuffer(1024);
    new Uint8Array(fakeAudio).fill(42);

    mockSpeakSsmlAsync.mockImplementation(
      (
        _ssml: string,
        cb: (result: { reason: number; audioData: ArrayBuffer }) => void,
      ) => {
        cb({ reason: 8, audioData: fakeAudio }); // 8 = SynthesizingAudioCompleted
      },
    );

    const result = await synthesizeSpeech('Dobar dan', 'bs-BA');

    expect(result).toBeInstanceOf(Buffer);
    expect(result.byteLength).toBe(1024);
    expect(mockClose).toHaveBeenCalled();
  });

  it('rejects when synthesis fails with non-completed reason', async () => {
    mockSpeakSsmlAsync.mockImplementation(
      (
        _ssml: string,
        cb: (result: { reason: number; audioData: ArrayBuffer }) => void,
      ) => {
        cb({ reason: 1, audioData: new ArrayBuffer(0) }); // 1 = Canceled
      },
    );

    await expect(synthesizeSpeech('Fail text', 'sr-RS')).rejects.toThrow();
    expect(mockClose).toHaveBeenCalled();
  });

  it('rejects when Azure SDK calls the error callback', async () => {
    mockSpeakSsmlAsync.mockImplementation(
      (
        _ssml: string,
        _cb: unknown,
        errCb: (error: string) => void,
      ) => {
        errCb('Network timeout');
      },
    );

    await expect(synthesizeSpeech('Timeout text', 'bs-BA')).rejects.toThrow(
      'Azure TTS SDK error: Network timeout',
    );
    expect(mockClose).toHaveBeenCalled();
  });

  it('uses default voice for language when no voice is provided', async () => {
    const fakeAudio = new ArrayBuffer(512);

    mockSpeakSsmlAsync.mockImplementation(
      (
        ssml: string,
        cb: (result: { reason: number; audioData: ArrayBuffer }) => void,
      ) => {
        // Verify the SSML contains the default Bosnian voice
        expect(ssml).toContain('bs-BA-GoranNeural');
        cb({ reason: 8, audioData: fakeAudio });
      },
    );

    await synthesizeSpeech('Test', 'bs-BA');
    expect(mockSpeakSsmlAsync).toHaveBeenCalledTimes(1);
  });
});
