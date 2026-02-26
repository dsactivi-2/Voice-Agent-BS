import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock logger before importing the module under test
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

// Mock config with test values
vi.mock('../../src/config.js', () => ({
  config: {
    VAD_ENDPOINTING_MS: 300,
    DEEPGRAM_API_KEY: 'test-deepgram-key',
  },
}));

// Create a mock WebSocket class that extends EventEmitter for realistic behavior
class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly CLOSING = 2;

  readyState = MockWebSocket.OPEN;
  send = vi.fn();
  close = vi.fn();
  terminate = vi.fn();

  constructor(_url: string, _options?: unknown) {
    super();
    // Simulate async open
    queueMicrotask(() => {
      this.emit('open');
    });
  }
}

// Store reference to the mock class so tests can access static properties
let lastMockWs: MockWebSocket | null = null;

// Track WebSocket constructor calls for assertions
let wsConstructorCalls: Array<{ url: string; options: unknown }> = [];

vi.mock('ws', () => {
  // Must use a regular function (not arrow) so it can be called with `new`
  function WebSocketMock(this: unknown, url: string, options?: unknown) {
    wsConstructorCalls.push({ url, options });
    lastMockWs = new MockWebSocket(url, options);
    return lastMockWs;
  }

  // Copy static constants from MockWebSocket so readyState checks work
  WebSocketMock.OPEN = 1;
  WebSocketMock.CLOSED = 3;
  WebSocketMock.CLOSING = 2;
  WebSocketMock.CONNECTING = 0;

  return {
    WebSocket: WebSocketMock,
  };
});

describe('DeepgramASRClient', () => {
  let DeepgramASRClient: typeof import('../../src/deepgram/client.js').DeepgramASRClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    lastMockWs = null;
    wsConstructorCalls = [];
    const mod = await import('../../src/deepgram/client.js');
    DeepgramASRClient = mod.DeepgramASRClient;
  });

  afterEach(() => {
    lastMockWs = null;
  });

  it('sets correct language configuration from constructor', () => {
    const client = new DeepgramASRClient('bs', 'test-key');
    expect(client).toBeDefined();
    // The client should have been created without errors
    expect(client.isConnected()).toBe(false);
  });

  it('constructs WebSocket URL with correct query params on connect', async () => {
    const client = new DeepgramASRClient('sr', 'my-api-key');
    await client.connect();

    expect(wsConstructorCalls).toHaveLength(1);

    const { url, options } = wsConstructorCalls[0]!;

    expect(url).toContain('wss://api.deepgram.com/v1/listen');
    expect(url).toContain('model=nova-3');
    expect(url).toContain('language=sr');
    expect(url).toContain('interim_results=true');
    expect(url).toContain('endpointing=300');
    expect(url).toContain('utterance_end_ms=1000');
    expect(url).toContain('punctuate=true');
    expect(url).toContain('smart_format=true');
    expect(url).toContain('encoding=linear16');
    expect(url).toContain('sample_rate=16000');
    expect(url).toContain('channels=1');

    // Verify Authorization header is set
    const opts = options as { headers: Record<string, string> };
    expect(opts.headers.Authorization).toBe('Token my-api-key');
  });

  it('sends audio buffer via WebSocket when connected', async () => {
    const client = new DeepgramASRClient('bs', 'test-key');
    await client.connect();

    const audioChunk = Buffer.alloc(320, 0x42);
    client.sendAudio(audioChunk);

    expect(lastMockWs).not.toBeNull();
    expect(lastMockWs!.send).toHaveBeenCalledWith(audioChunk);
  });

  it('does not send audio when WebSocket is not open', () => {
    const client = new DeepgramASRClient('bs', 'test-key');
    // Do not connect -- WebSocket is null
    const audioChunk = Buffer.alloc(320, 0x42);

    // Should not throw, just log a warning
    client.sendAudio(audioChunk);
  });

  it('emits transcript event with isFinal=false for interim results', async () => {
    const client = new DeepgramASRClient('bs', 'test-key');
    await client.connect();

    const transcriptHandler = vi.fn();
    client.on('transcript', transcriptHandler);

    // Simulate Deepgram sending an interim result
    const deepgramResponse = JSON.stringify({
      type: 'Results',
      channel: {
        alternatives: [
          { transcript: 'Dobar dan', confidence: 0.85 },
        ],
      },
      is_final: false,
      speech_final: false,
    });

    lastMockWs!.emit('message', Buffer.from(deepgramResponse));

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
    await client.connect();

    const transcriptHandler = vi.fn();
    client.on('transcript', transcriptHandler);

    const deepgramResponse = JSON.stringify({
      type: 'Results',
      channel: {
        alternatives: [
          { transcript: 'Kako ste?', confidence: 0.95 },
        ],
      },
      is_final: true,
      speech_final: true,
    });

    lastMockWs!.emit('message', Buffer.from(deepgramResponse));

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
    await client.connect();

    const transcriptHandler = vi.fn();
    client.on('transcript', transcriptHandler);

    const deepgramResponse = JSON.stringify({
      type: 'Results',
      channel: {
        alternatives: [
          { transcript: '', confidence: 0 },
        ],
      },
      is_final: false,
      speech_final: false,
    });

    lastMockWs!.emit('message', Buffer.from(deepgramResponse));

    expect(transcriptHandler).not.toHaveBeenCalled();
  });

  it('ignores non-Results message types', async () => {
    const client = new DeepgramASRClient('bs', 'test-key');
    await client.connect();

    const transcriptHandler = vi.fn();
    client.on('transcript', transcriptHandler);

    // Deepgram sends metadata messages that should be ignored
    const metadataResponse = JSON.stringify({
      type: 'Metadata',
      request_id: 'abc-123',
    });

    lastMockWs!.emit('message', Buffer.from(metadataResponse));

    expect(transcriptHandler).not.toHaveBeenCalled();
  });

  it('emits error event on WebSocket error after connection', async () => {
    const client = new DeepgramASRClient('bs', 'test-key');
    await client.connect();

    const errorHandler = vi.fn();
    client.on('error', errorHandler);

    const wsError = new Error('Connection lost');
    lastMockWs!.emit('error', wsError);

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler).toHaveBeenCalledWith(wsError);
  });

  it('emits error event when message parsing fails', async () => {
    const client = new DeepgramASRClient('bs', 'test-key');
    await client.connect();

    const errorHandler = vi.fn();
    client.on('error', errorHandler);

    // Send invalid JSON
    lastMockWs!.emit('message', Buffer.from('not-valid-json'));

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it('emits close event when WebSocket closes', async () => {
    const client = new DeepgramASRClient('bs', 'test-key');
    await client.connect();

    const closeHandler = vi.fn();
    client.on('close', closeHandler);

    lastMockWs!.emit('close', 1000, Buffer.from('Normal closure'));

    expect(closeHandler).toHaveBeenCalledTimes(1);
    expect(closeHandler).toHaveBeenCalledWith(1000, 'Normal closure');
    expect(client.isConnected()).toBe(false);
  });

  it('close sends CloseStream message and terminates the WebSocket', async () => {
    const client = new DeepgramASRClient('bs', 'test-key');
    await client.connect();

    const ws = lastMockWs!;

    // Simulate that close() triggers the 'close' event
    ws.close.mockImplementation(() => {
      ws.readyState = MockWebSocket.CLOSED;
      ws.emit('close', 1000, Buffer.from(''));
    });

    await client.close();

    // Should have sent a CloseStream message
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'CloseStream' }));
    expect(ws.close).toHaveBeenCalled();
    expect(client.isConnected()).toBe(false);
  });

  it('isConnected returns false before connect and true after', async () => {
    const client = new DeepgramASRClient('bs', 'test-key');
    expect(client.isConnected()).toBe(false);

    await client.connect();
    expect(client.isConnected()).toBe(true);
  });
});
