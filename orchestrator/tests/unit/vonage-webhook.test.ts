import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildAnswerNcco,
  createAnswerHandler,
  createEventHandler,
  vonageEventPayloadSchema,
} from '../../src/vonage/webhook.js';

// ---------------------------------------------------------------------------
// Mock logger to prevent actual logging during tests
// ---------------------------------------------------------------------------

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    PORT: 3000,
    TELEPHONY_PROVIDER: 'vonage',
  },
}));

// ---------------------------------------------------------------------------
// Helper: mock Fastify request/reply
// ---------------------------------------------------------------------------

function createMockRequest(overrides: Record<string, unknown> = {}) {
  return {
    query: {},
    body: {},
    headers: {},
    ...overrides,
  } as unknown as import('fastify').FastifyRequest;
}

function createMockReply() {
  const reply = {
    status: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply as unknown as import('fastify').FastifyReply;
}

// ---------------------------------------------------------------------------
// Tests: buildAnswerNcco
// ---------------------------------------------------------------------------

describe('buildAnswerNcco', () => {
  it('should return valid NCCO with websocket endpoint', () => {
    const ncco = buildAnswerNcco('test-call-id-123', 'voice.activi.io');

    expect(ncco).toHaveLength(1);
    expect(ncco[0]).toEqual({
      action: 'connect',
      endpoint: [
        {
          type: 'websocket',
          uri: 'wss://voice.activi.io/vonage/media?call_id=test-call-id-123',
          'content-type': 'audio/l16;rate=16000',
          headers: {
            call_id: 'test-call-id-123',
          },
        },
      ],
    });
  });

  it('should include correct WebSocket URI with the given base URL', () => {
    const ncco = buildAnswerNcco('uuid-abc', 'custom-host.example.com');

    const connectAction = ncco[0] as { action: string; endpoint: Array<{ uri: string }> };
    expect(connectAction.endpoint[0]!.uri).toBe('wss://custom-host.example.com/vonage/media?call_id=uuid-abc');
  });

  it('should set audio content type to 16kHz PCM', () => {
    const ncco = buildAnswerNcco('uuid-xyz', 'voice.activi.io');

    const connectAction = ncco[0] as {
      action: string;
      endpoint: Array<{ 'content-type': string }>;
    };
    expect(connectAction.endpoint[0]!['content-type']).toBe('audio/l16;rate=16000');
  });

  it('should include call_id in WebSocket headers', () => {
    const callId = 'my-unique-call-id';
    const ncco = buildAnswerNcco(callId, 'voice.activi.io');

    const connectAction = ncco[0] as {
      action: string;
      endpoint: Array<{ headers: Record<string, string> }>;
    };
    expect(connectAction.endpoint[0]!.headers['call_id']).toBe(callId);
  });
});

// ---------------------------------------------------------------------------
// Tests: Answer URL handler (GET /vonage/answer)
// ---------------------------------------------------------------------------

describe('createAnswerHandler', () => {
  it('should return NCCO JSON with status 200', async () => {
    const handler = createAnswerHandler('voice.activi.io');
    const request = createMockRequest({
      query: { uuid: 'call-uuid-1', from: '+38761111111', to: '+38762222222' },
    });
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.header).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(reply.send).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'connect',
          endpoint: expect.arrayContaining([
            expect.objectContaining({
              type: 'websocket',
              uri: expect.stringContaining('wss://voice.activi.io/vonage/media'),
            }),
          ]),
        }),
      ]),
    );
  });

  it('should use conversation_uuid as fallback when uuid is missing', async () => {
    const handler = createAnswerHandler('voice.activi.io');
    const request = createMockRequest({
      query: { conversation_uuid: 'conv-uuid-fallback' },
    });
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(200);

    const sentNcco = (reply.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Array<{
      action: string;
      endpoint: Array<{ headers: Record<string, string> }>;
    }>;
    expect(sentNcco[0]!.endpoint[0]!.headers['call_id']).toBe('conv-uuid-fallback');
  });
});

// ---------------------------------------------------------------------------
// Tests: Event URL handler (POST /vonage/events)
// ---------------------------------------------------------------------------

describe('createEventHandler', () => {
  it('should process completed event and invoke onCallCompleted callback', async () => {
    const onCallCompleted = vi.fn();
    const handler = createEventHandler({ onCallCompleted });
    const request = createMockRequest({
      body: {
        uuid: 'call-uuid-completed',
        status: 'completed',
        from: '+38761111111',
        to: '+38762222222',
        duration: '45',
        reason: 'normal',
      },
    });
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(onCallCompleted).toHaveBeenCalledWith('call-uuid-completed', 'normal', '45');
  });

  it('should process answered event and invoke onCallAnswered callback', async () => {
    const onCallAnswered = vi.fn();
    const handler = createEventHandler({ onCallAnswered });
    const request = createMockRequest({
      body: {
        uuid: 'call-uuid-answered',
        status: 'answered',
        from: '+38761111111',
        to: '+38762222222',
      },
    });
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(onCallAnswered).toHaveBeenCalledWith('call-uuid-answered', '+38761111111', '+38762222222');
  });

  it('should return 400 for invalid event body', async () => {
    const handler = createEventHandler();
    const request = createMockRequest({
      body: {
        // Missing required 'uuid' and 'status' fields
        invalid: 'payload',
      },
    });
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Invalid event body' });
  });

  it('should return 200 for valid events with no matching callback', async () => {
    const handler = createEventHandler();
    const request = createMockRequest({
      body: {
        uuid: 'call-uuid-ringing',
        status: 'ringing',
      },
    });
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ status: 'ok' });
  });

  it('should invoke onCallStarted for started status', async () => {
    const onCallStarted = vi.fn();
    const handler = createEventHandler({ onCallStarted });
    const request = createMockRequest({
      body: {
        uuid: 'call-uuid-started',
        status: 'started',
        from: '+38761111111',
        to: '+38762222222',
      },
    });
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(onCallStarted).toHaveBeenCalledWith('call-uuid-started', '+38761111111', '+38762222222');
  });
});

// ---------------------------------------------------------------------------
// Tests: Zod schema validation
// ---------------------------------------------------------------------------

describe('vonageEventPayloadSchema', () => {
  it('should validate a minimal valid payload', () => {
    const result = vonageEventPayloadSchema.safeParse({
      uuid: 'abc-123',
      status: 'completed',
    });

    expect(result.success).toBe(true);
  });

  it('should reject payload missing uuid', () => {
    const result = vonageEventPayloadSchema.safeParse({
      status: 'completed',
    });

    expect(result.success).toBe(false);
  });

  it('should reject payload missing status', () => {
    const result = vonageEventPayloadSchema.safeParse({
      uuid: 'abc-123',
    });

    expect(result.success).toBe(false);
  });
});
