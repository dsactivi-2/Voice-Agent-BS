import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Minimal WebSocket stub
// ---------------------------------------------------------------------------

function makeWs(overrides: Partial<WebSocket> = {}): WebSocket {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    OPEN: 1,
    readyState: 1,
    binaryType: 'nodebuffer',
    send: vi.fn(),
    close: vi.fn(),
    ...overrides,
  }) as unknown as WebSocket;
}

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

async function load() {
  const mod = await import('../../src/vonage/media-stream.js');
  return { VonageMediaSession: mod.VonageMediaSession, VONAGE_FRAME_BYTES: mod.VONAGE_FRAME_BYTES };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VONAGE_FRAME_BYTES', () => {
  it('equals 640', async () => {
    const { VONAGE_FRAME_BYTES } = await load();
    expect(VONAGE_FRAME_BYTES).toBe(640);
  });
});

describe('VonageMediaSession.sendAudio', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends a single 640-byte buffer as one frame', async () => {
    const { VonageMediaSession } = await load();
    const ws = makeWs();
    const session = new VonageMediaSession(ws);
    const audio = Buffer.alloc(640, 0xab);

    session.sendAudio(audio);

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(640);
  });

  it('splits a 1920-byte buffer into exactly 3 × 640-byte frames', async () => {
    const { VonageMediaSession } = await load();
    const ws = makeWs();
    const session = new VonageMediaSession(ws);
    const audio = Buffer.alloc(1920, 0x01);

    session.sendAudio(audio);

    expect(ws.send).toHaveBeenCalledTimes(3);
    for (const call of (ws.send as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]).toHaveLength(640);
    }
  });

  it('sends remaining bytes as a partial last frame when length is not a multiple of 640', async () => {
    const { VonageMediaSession } = await load();
    const ws = makeWs();
    const session = new VonageMediaSession(ws);
    // 1400 bytes = 2 full frames (1280) + 1 partial (120)
    const audio = Buffer.alloc(1400, 0x02);

    session.sendAudio(audio);

    expect(ws.send).toHaveBeenCalledTimes(3);
    const calls = (ws.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toHaveLength(640);
    expect(calls[1][0]).toHaveLength(640);
    expect(calls[2][0]).toHaveLength(120);
  });

  it('sends a large TTS buffer (160 000 bytes) as 250 full frames', async () => {
    const { VonageMediaSession } = await load();
    const ws = makeWs();
    const session = new VonageMediaSession(ws);
    // 5 seconds of audio @ 32 000 bytes/sec
    const audio = Buffer.alloc(160_000, 0x03);

    session.sendAudio(audio);

    expect(ws.send).toHaveBeenCalledTimes(250);
    for (const call of (ws.send as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]).toHaveLength(640);
    }
  });

  it('preserves byte content across all frames', async () => {
    const { VonageMediaSession } = await load();
    const ws = makeWs();
    const session = new VonageMediaSession(ws);
    const audio = Buffer.from(Array.from({ length: 1280 }, (_, i) => i % 256));

    session.sendAudio(audio);

    const calls = (ws.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    // Reconstruct the original buffer from all sent frames
    const reconstructed = Buffer.concat(calls.map((c: Buffer[]) => c[0] as Buffer));
    expect(reconstructed).toEqual(audio);
  });

  it('does nothing when WebSocket is closed', async () => {
    const { VonageMediaSession } = await load();
    const ws = makeWs({ readyState: 3 }); // CLOSED
    const session = new VonageMediaSession(ws);

    session.sendAudio(Buffer.alloc(640));

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('emits error event when ws.send throws', async () => {
    const { VonageMediaSession } = await load();
    const ws = makeWs();
    (ws.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('WS send failed');
    });
    const session = new VonageMediaSession(ws);
    const onError = vi.fn();
    session.on('error', onError);

    session.sendAudio(Buffer.alloc(640, 0x05));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('WS send failed');
  });

  it('clearAudioQueue is a no-op (synchronous sending has no queue)', async () => {
    const { VonageMediaSession } = await load();
    const ws = makeWs();
    const session = new VonageMediaSession(ws);

    // Should not throw
    expect(() => session.clearAudioQueue()).not.toThrow();
  });
});

describe('VonageMediaSession metadata parsing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits start event with callId from headers', async () => {
    const { VonageMediaSession } = await load();
    const ws = makeWs();
    const session = new VonageMediaSession(ws);
    const onStart = vi.fn();
    session.on('start', onStart);

    // Simulate Vonage first message with call_id in headers
    const metadata = JSON.stringify({
      event: 'websocket:connected',
      'content-type': 'audio/l16;rate=16000',
      headers: { call_id: 'test-call-uuid-123' },
    });
    ws.emit('message', Buffer.from(metadata));

    expect(onStart).toHaveBeenCalledWith({
      callId: 'test-call-uuid-123',
      contentType: 'audio/l16;rate=16000',
    });
  });

  it('falls back to unknown when neither headers.call_id nor uuid is present', async () => {
    const { VonageMediaSession } = await load();
    const ws = makeWs();
    const session = new VonageMediaSession(ws);
    const onStart = vi.fn();
    session.on('start', onStart);

    const metadata = JSON.stringify({
      event: 'websocket:connected',
      'content-type': 'audio/l16;rate=16000',
    });
    ws.emit('message', Buffer.from(metadata));

    expect(onStart).toHaveBeenCalledWith({
      callId: 'unknown',
      contentType: 'audio/l16;rate=16000',
    });
  });

  it('M1: uses top-level uuid when headers has no call_id', async () => {
    const { VonageMediaSession } = await load();
    const ws = makeWs();
    const session = new VonageMediaSession(ws);
    const onStart = vi.fn();
    session.on('start', onStart);

    // Vonage standard metadata format — uuid at top level, no custom call_id in headers
    const metadata = JSON.stringify({
      event: 'websocket:connected',
      'content-type': 'audio/l16;rate=16000',
      uuid: 'CON-abc123-def456',
      headers: {},
    });
    ws.emit('message', Buffer.from(metadata));

    expect(onStart).toHaveBeenCalledWith({
      callId: 'CON-abc123-def456',
      contentType: 'audio/l16;rate=16000',
    });

    // getCallId() should also return the uuid
    expect(session.getCallId()).toBe('CON-abc123-def456');
  });

  it('M1: prefers headers.call_id over top-level uuid', async () => {
    const { VonageMediaSession } = await load();
    const ws = makeWs();
    const session = new VonageMediaSession(ws);
    const onStart = vi.fn();
    session.on('start', onStart);

    // Both present — headers.call_id wins (it's our custom injected value)
    const metadata = JSON.stringify({
      event: 'websocket:connected',
      'content-type': 'audio/l16;rate=16000',
      uuid: 'CON-vonage-uuid',
      headers: { call_id: 'our-call-id-from-ncco' },
    });
    ws.emit('message', Buffer.from(metadata));

    expect(onStart).toHaveBeenCalledWith({
      callId: 'our-call-id-from-ncco',
      contentType: 'audio/l16;rate=16000',
    });
  });

  it('M1: uuid extracted from metadata is available via getCallId()', async () => {
    const { VonageMediaSession } = await load();
    const ws = makeWs();
    const session = new VonageMediaSession(ws);

    const metadata = JSON.stringify({
      uuid: 'CON-get-call-id-test',
      'content-type': 'audio/l16;rate=16000',
    });
    ws.emit('message', Buffer.from(metadata));

    expect(session.getCallId()).toBe('CON-get-call-id-test');
  });

  it('emits audio event for binary frames after metadata', async () => {
    const { VonageMediaSession } = await load();
    const ws = makeWs();
    const session = new VonageMediaSession(ws);

    // First: metadata
    ws.emit('message', Buffer.from(JSON.stringify({ event: 'websocket:connected' })));

    const onAudio = vi.fn();
    session.on('audio', onAudio);

    // Then: binary frame
    const frame = Buffer.alloc(640, 0x10);
    ws.emit('message', frame);

    expect(onAudio).toHaveBeenCalledWith(frame);
  });
});
