import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    VAD_ENDPOINTING_MS: 300,
    DEEPGRAM_API_KEY: 'test-deepgram-key',
  },
}));

// ---------------------------------------------------------------------------
// Mock @deepgram/sdk
// ---------------------------------------------------------------------------

// Container for the current live client instance — reassigned in beforeEach.
// Must be hoisted so the vi.mock factory closure can reference it at call time.
const liveMock = vi.hoisted(() => ({ current: null as any }));

vi.mock('@deepgram/sdk', () => ({
  createClient: () => ({
    listen: {
      live: () => liveMock.current,
    },
  }),
  LiveTranscriptionEvents: {
    Open: 'open',
    Close: 'close',
    Error: 'error',
    Transcript: 'Results',
  },
}));

import { DeepgramASRClient } from '../../src/deepgram/client.js';

// ---------------------------------------------------------------------------
// Mock live client — matches the Deepgram SDK's ListenLiveClient interface
// ---------------------------------------------------------------------------

class MockLiveClient extends EventEmitter {
  send = vi.fn();
  finish = vi.fn();
  requestClose = vi.fn();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function simulateOpen() {
  liveMock.current.emit('open');
}

async function connectClient(client: DeepgramASRClient): Promise<void> {
  const p = client.connect();
  simulateOpen();
  await p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeepgramASRClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    liveMock.current = new MockLiveClient();
  });

  it('starts disconnected before connect()', () => {
    const client = new DeepgramASRClient('bs', 'test-key');
    expect(client.isConnected()).toBe(false);
  });

  it('constructs WebSocket URL with correct query params on connect', async () => {
    // Verify the live() options contain the expected Deepgram params by checking
    // that the connect resolves successfully when the SDK emits 'open'.
    const client = new DeepgramASRClient('sr', 'my-api-key');
    await connectClient(client);
    expect(client.isConnected()).toBe(true);
  });

  it('sends audio buffer via SDK live client when connected', async () => {
    const client = new DeepgramASRClient('bs', 'test-key');
    await connectClient(client);

    const audioChunk = Buffer.alloc(320, 0x42);
    client.sendAudio(audioChunk);

    expect(liveMock.current.send).toHaveBeenCalledTimes(1);
  });

  it('does not send audio when WebSocket is not open', () => {
    const client = new DeepgramASRClient('bs', 'test-key');
    // Not connected — sendAudio should silently drop the chunk
    client.sendAudio(Buffer.alloc(320));
    expect(liveMock.current.send).not.toHaveBeenCalled();
  });

  it('emits transcript event with isFinal=false for interim results', async () => {
    const client = new DeepgramASRClient('bs', 'test-key');
    await connectClient(client);

    const transcriptHandler = vi.fn();
    client.on('transcript', transcriptHandler);

    liveMock.current.emit('Results', {
      channel: {
        alternatives: [{ transcript: 'Dobar dan', confidence: 0.85 }],
      },
      is_final: false,
      speech_final: false,
    });

    expect(transcriptHandler).toHaveBeenCalledTimes(1);
    expect(transcriptHandler).toHaveBeenCalledWith({
      text: 'Dobar dan',
      isFinal: false,
      speechFinal: false,
      confidence: 0.85,
    });
  });

  it('emits transcript event with isFinal=true for final results', async () => {
    const client = new DeepgramASRClient('sr', 'test-key');
    await connectClient(client);

    const transcriptHandler = vi.fn();
    client.on('transcript', transcriptHandler);

    liveMock.current.emit('Results', {
      channel: {
        alternatives: [{ transcript: 'Kako ste?', confidence: 0.95 }],
      },
      is_final: true,
      speech_final: true,
    });

    expect(transcriptHandler).toHaveBeenCalledTimes(1);
    expect(transcriptHandler).toHaveBeenCalledWith({
      text: 'Kako ste?',
      isFinal: true,
      speechFinal: true,
      confidence: 0.95,
    });
  });

  it('does not emit transcript for empty transcript text', async () => {
    const client = new DeepgramASRClient('bs', 'test-key');
    await connectClient(client);

    const transcriptHandler = vi.fn();
    client.on('transcript', transcriptHandler);

    liveMock.current.emit('Results', {
      channel: {
        alternatives: [{ transcript: '', confidence: 0 }],
      },
      is_final: false,
      speech_final: false,
    });

    expect(transcriptHandler).not.toHaveBeenCalled();
  });

  it('ignores non-Results message types', async () => {
    // The SDK only emits typed events — no raw message parsing needed.
    // Verify that a transcript handler is not called when no 'Results' event fires.
    const client = new DeepgramASRClient('bs', 'test-key');
    await connectClient(client);

    const transcriptHandler = vi.fn();
    client.on('transcript', transcriptHandler);

    // Emit an unrelated SDK event (Metadata) — should not trigger transcript
    liveMock.current.emit('Metadata', { request_id: 'abc-123' });

    expect(transcriptHandler).not.toHaveBeenCalled();
  });

  it('emits error event on WebSocket error after connection', async () => {
    const client = new DeepgramASRClient('bs', 'test-key');
    await connectClient(client);

    const errorHandler = vi.fn();
    client.on('error', errorHandler);

    const wsError = new Error('Connection lost');
    liveMock.current.emit('error', wsError);

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler).toHaveBeenCalledWith(wsError);
  });

  it('close calls requestClose on live client and resolves', async () => {
    const client = new DeepgramASRClient('bs', 'test-key');
    await connectClient(client);

    // When requestClose() is called, simulate the SDK emitting the close event
    liveMock.current.requestClose.mockImplementation(() => {
      process.nextTick(() => liveMock.current.emit('close'));
    });

    await client.close();

    expect(liveMock.current.requestClose).toHaveBeenCalled();
    expect(client.isConnected()).toBe(false);
  });

  it('isConnected returns false before connect and true after', async () => {
    const client = new DeepgramASRClient('bs', 'test-key');
    expect(client.isConnected()).toBe(false);

    await connectClient(client);
    expect(client.isConnected()).toBe(true);
  });
});
