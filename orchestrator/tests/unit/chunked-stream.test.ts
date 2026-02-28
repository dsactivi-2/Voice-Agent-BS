import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Language } from '../../src/types.js';

// Mock logger
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock config
vi.mock('../../src/config.js', () => ({
  config: {
    AZURE_SPEECH_KEY: 'test-key',
    AZURE_REGION: 'westeurope',
    TTS_VOICE_BS: 'bs-BA-GoranNeural',
    TTS_VOICE_SR: 'sr-RS-NicholasNeural',
    TTS_CACHE_TTL_SECONDS: 86400,
  },
}));

// Mock Azure TTS client
const mockSynthesizeSpeech = vi.fn<[string, Language, string?], Promise<Buffer>>();
vi.mock('../../src/tts/azure-client.js', () => ({
  synthesizeSpeech: (...args: [string, Language, string?]) => mockSynthesizeSpeech(...args),
}));

// Mock cache
const mockGetCachedAudio = vi.fn<[string], Promise<Buffer | null>>();
const mockSetCachedAudio = vi.fn<[string, Buffer, number?], Promise<void>>();
vi.mock('../../src/tts/cache.js', () => ({
  getCachedAudio: (...args: [string]) => mockGetCachedAudio(...args),
  setCachedAudio: (...args: [string, Buffer, number?]) => mockSetCachedAudio(...args),
}));

// Use fake timers for timeout-based tests
describe('shouldFlushChunk', () => {
  let shouldFlushChunk: (buffer: string, waitTimeMs: number) => boolean;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../src/tts/chunked-stream.js');
    shouldFlushChunk = mod.shouldFlushChunk;
  });

  it('returns false when buffer is shorter than MIN_CHUNK_LENGTH', () => {
    expect(shouldFlushChunk('Hi.', 0)).toBe(false);
    expect(shouldFlushChunk('Short text', 5000)).toBe(false);
  });

  it('returns true when buffer ends with period and meets min length', () => {
    expect(shouldFlushChunk('This is a suitably long sentence that will trigger the TTS pipeline flush when full.', 0)).toBe(true);
  });

  it('returns true when buffer ends with question mark and meets min length', () => {
    expect(shouldFlushChunk('Da li biste bili zainteresovani za jedno od nasih radnih mjesta u Njemackoj ili Austriji?', 0)).toBe(true);
  });

  it('returns true when MAX_WAIT_MS exceeded and meets min length', () => {
    expect(shouldFlushChunk('This text contains no sentence-ending punctuation and is longer than the minimum length', 800)).toBe(true);
    expect(shouldFlushChunk('This text contains no sentence-ending punctuation and is longer than the minimum length', 1000)).toBe(true);
  });

  it('returns false when MAX_WAIT_MS not reached and no trigger', () => {
    expect(shouldFlushChunk('This has no ending', 500)).toBe(false);
  });
});

describe('ChunkedTTSPipeline', () => {
  let ChunkedTTSPipeline: typeof import('../../src/tts/chunked-stream.js').ChunkedTTSPipeline;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetCachedAudio.mockResolvedValue(null);
    mockSetCachedAudio.mockResolvedValue(undefined);
    mockSynthesizeSpeech.mockResolvedValue(Buffer.alloc(512));

    const mod = await import('../../src/tts/chunked-stream.js');
    ChunkedTTSPipeline = mod.ChunkedTTSPipeline;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('buffers short text below MIN_CHUNK_LENGTH without flushing', async () => {
    const onAudio = vi.fn();
    const pipeline = new ChunkedTTSPipeline('bs-BA', undefined, onAudio);
    const chunkReady = vi.fn();
    pipeline.on('chunkReady', chunkReady);

    pipeline.addTokens('Hi');

    // No immediate flush
    expect(chunkReady).not.toHaveBeenCalled();
    expect(mockSynthesizeSpeech).not.toHaveBeenCalled();

    pipeline.destroy();
  });

  it('flushes buffer when text ends with a period and meets min length', async () => {
    const onAudio = vi.fn();
    const pipeline = new ChunkedTTSPipeline('bs-BA', undefined, onAudio);
    const chunkReady = vi.fn();
    pipeline.on('chunkReady', chunkReady);

    const text = 'Ovo je dovoljno dugacka recenica koja prelazi minimum od osamdeset karaktera za TTS.';
    pipeline.addTokens(text);

    // Should emit chunkReady synchronously
    expect(chunkReady).toHaveBeenCalledWith(text);

    // Allow microtask for async synthesis to complete
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSynthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(mockSynthesizeSpeech).toHaveBeenCalledWith(text, 'bs-BA', undefined);

    pipeline.destroy();
  });

  it('forces flush after MAX_WAIT_MS timeout even without punctuation', async () => {
    const onAudio = vi.fn();
    const pipeline = new ChunkedTTSPipeline('sr-RS', undefined, onAudio);
    const chunkReady = vi.fn();
    pipeline.on('chunkReady', chunkReady);

    // Add enough text to exceed MIN_CHUNK_LENGTH but without a trigger
    pipeline.addTokens('Ovo je tekst bez kraja');

    // Not flushed yet (no trigger, timer not fired)
    expect(chunkReady).not.toHaveBeenCalled();

    // Advance past MAX_WAIT_MS to fire the timeout
    await vi.advanceTimersByTimeAsync(800);

    expect(chunkReady).toHaveBeenCalledWith('Ovo je tekst bez kraja');

    pipeline.destroy();
  });

  it('sends remaining buffer on explicit flush()', async () => {
    const onAudio = vi.fn();
    const pipeline = new ChunkedTTSPipeline('bs-BA', undefined, onAudio);

    // Add text that does not trigger automatic flush
    pipeline.addTokens('Ostatak teksta');

    expect(mockSynthesizeSpeech).not.toHaveBeenCalled();

    // Explicitly flush
    const flushPromise = pipeline.flush();
    await vi.advanceTimersByTimeAsync(0);
    await flushPromise;

    expect(mockSynthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(mockSynthesizeSpeech).toHaveBeenCalledWith(
      'Ostatak teksta',
      'bs-BA',
      undefined,
    );

    pipeline.destroy();
  });

  it('processes multiple chunks sequentially from streamed tokens', async () => {
    const onAudio = vi.fn();
    const pipeline = new ChunkedTTSPipeline('bs-BA', undefined, onAudio);

    // First sentence — 80+ chars ending with period triggers auto-flush
    pipeline.addTokens('Ovo je prva dovoljno dugacka recenica koja prelazi minimum osamdeset karaktera za TTS.');

    // Second sentence — also 80+ chars, triggers its own flush
    pipeline.addTokens('Druga recenica treba biti jednako dugacka da takodje bude automatski flushirana.');

    // Allow async work to complete
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSynthesizeSpeech).toHaveBeenCalledTimes(2);

    pipeline.destroy();
  });

  it('serves audio from cache on cache hit without calling Azure', async () => {
    const cachedBuffer = Buffer.from('cached-audio');
    mockGetCachedAudio.mockResolvedValue(cachedBuffer);

    const onAudio = vi.fn();
    const pipeline = new ChunkedTTSPipeline('bs-BA', undefined, onAudio);

    const text = 'Da li biste bili zainteresovani za jedno od nasih radnih mjesta u Njemackoj ili Austriji?';
    pipeline.addTokens(text);

    // Let async cache check resolve
    await vi.advanceTimersByTimeAsync(0);

    // Azure should NOT have been called
    expect(mockSynthesizeSpeech).not.toHaveBeenCalled();

    // Audio callback should have been invoked with cached data
    expect(onAudio).toHaveBeenCalledWith(cachedBuffer, text);

    pipeline.destroy();
  });

  it('emits done event after flush completes', async () => {
    const onAudio = vi.fn();
    const pipeline = new ChunkedTTSPipeline('bs-BA', undefined, onAudio);
    const onDone = vi.fn();
    pipeline.on('done', onDone);

    pipeline.addTokens('Završni tekst.');

    const flushPromise = pipeline.flush();
    await vi.advanceTimersByTimeAsync(0);
    await flushPromise;

    expect(onDone).toHaveBeenCalledTimes(1);

    pipeline.destroy();
  });

  it('emits error event when synthesis fails', async () => {
    mockSynthesizeSpeech.mockRejectedValue(new Error('Azure down'));

    const onAudio = vi.fn();
    const pipeline = new ChunkedTTSPipeline('bs-BA', undefined, onAudio);
    const onError = vi.fn();
    pipeline.on('error', onError);

    const text = 'Ovo je tekst koji ne radi a treba biti dovoljno dugacak za automatski flush pipeline.';
    pipeline.addTokens(text);

    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Azure down' }),
      text,
    );
    expect(onAudio).not.toHaveBeenCalled();

    pipeline.destroy();
  });

  it('does not process tokens after destroy()', async () => {
    const onAudio = vi.fn();
    const pipeline = new ChunkedTTSPipeline('bs-BA', undefined, onAudio);

    pipeline.destroy();

    pipeline.addTokens('This should be ignored.');

    await vi.advanceTimersByTimeAsync(1000);

    expect(mockSynthesizeSpeech).not.toHaveBeenCalled();
    expect(onAudio).not.toHaveBeenCalled();
  });
});
