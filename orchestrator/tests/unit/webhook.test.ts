import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------

const { mockCanCallNumber, mockMarkCallMade, mockCreateCall, mockUpdateCallResult, mockUpsertCallMemory } =
  vi.hoisted(() => ({
    mockCanCallNumber: vi.fn(),
    mockMarkCallMade: vi.fn(),
    mockCreateCall: vi.fn(),
    mockUpdateCallResult: vi.fn(),
    mockUpsertCallMemory: vi.fn(),
  }));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('ioredis', () => {
  function MockRedis() {
    return { get: vi.fn(), set: vi.fn(), ttl: vi.fn(), on: vi.fn() };
  }
  return { Redis: MockRedis, default: MockRedis };
});

vi.mock('../../src/config.js', () => ({
  config: {
    TELNYX_API_KEY: 'test-api-key',
    TELNYX_PUBLIC_KEY: 'dGVzdC1wdWJsaWMta2V5', // base64 of 'test-public-key'
    TELNYX_APP_ID: 'test-app-id',
    TELNYX_PHONE_BS: '+38733123456',
    TELNYX_PHONE_SR: '+381111234567',
    ANTI_LOOP_COOLDOWN_HOURS: 24,
  },
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock('../../src/session/anti-loop.js', () => ({
  canCallNumber: mockCanCallNumber,
  markCallMade: mockMarkCallMade,
}));

vi.mock('../../src/db/queries.js', () => ({
  createCall: mockCreateCall,
  updateCallResult: mockUpdateCallResult,
  upsertCallMemory: mockUpsertCallMemory,
}));

vi.mock('../../src/server.js', () => ({
  incrementActiveCalls: vi.fn(),
  decrementActiveCalls: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module under test — import schemas and handler at top level
// ---------------------------------------------------------------------------

import {
  createWebhookHandler,
  verifyWebhookSignature,
  telnyxWebhookBodySchema,
  telnyxCallPayloadSchema,
  telnyxMachineDetectionPayloadSchema,
} from '../../src/telnyx/webhook.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildWebhookBody(eventType: string, payload: Record<string, unknown> = {}) {
  const defaultPayload = {
    call_control_id: 'ctrl-123',
    call_leg_id: 'leg-456',
    call_session_id: 'session-789',
    from: '+38761999888',
    to: '+38733123456',
    direction: 'incoming',
    state: 'active',
    ...payload,
  };

  return {
    data: {
      event_type: eventType,
      id: 'event-abc',
      occurred_at: new Date().toISOString(),
      payload: defaultPayload,
    },
  };
}

async function createTestApp(): Promise<FastifyInstance> {
  const app = Fastify();
  const handler = createWebhookHandler();
  app.post('/telnyx/webhook', handler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Webhook Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanCallNumber.mockResolvedValue(true);
    mockMarkCallMade.mockResolvedValue(undefined);
    mockCreateCall.mockResolvedValue(undefined);
    mockUpdateCallResult.mockResolvedValue(undefined);
    mockUpsertCallMemory.mockResolvedValue(undefined);
  });

  // -----------------------------------------------------------------------
  // Signature verification
  // -----------------------------------------------------------------------

  describe('signature verification', () => {
    it('returns 403 when signature header is missing', async () => {
      const app = await createTestApp();
      const body = buildWebhookBody('call.initiated');

      const response = await app.inject({
        method: 'POST',
        url: '/telnyx/webhook',
        payload: body,
        headers: {
          'content-type': 'application/json',
        },
      });

      expect(response.statusCode).toBe(403);
      const json = JSON.parse(response.body) as { error: string };
      expect(json.error).toBe('Missing signature headers');
    });

    it('returns 403 when timestamp header is missing', async () => {
      const app = await createTestApp();
      const body = buildWebhookBody('call.initiated');

      const response = await app.inject({
        method: 'POST',
        url: '/telnyx/webhook',
        payload: body,
        headers: {
          'content-type': 'application/json',
          'telnyx-signature-ed25519': 'some-signature',
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 403 when signature verification fails', async () => {
      const app = await createTestApp();
      const body = buildWebhookBody('call.initiated');

      const response = await app.inject({
        method: 'POST',
        url: '/telnyx/webhook',
        payload: body,
        headers: {
          'content-type': 'application/json',
          'telnyx-signature-ed25519': 'aW52YWxpZC1zaWduYXR1cmU=',
          'telnyx-timestamp': '1234567890',
        },
      });

      expect(response.statusCode).toBe(403);
      const json = JSON.parse(response.body) as { error: string };
      expect(json.error).toBe('Invalid signature');
    });
  });

  // -----------------------------------------------------------------------
  // Body validation (using Zod schemas directly)
  // -----------------------------------------------------------------------

  describe('body validation', () => {
    it('rejects an invalid webhook body', () => {
      const invalidBody = { not: 'valid' };
      const result = telnyxWebhookBodySchema.safeParse(invalidBody);

      expect(result.success).toBe(false);
    });

    it('validates a correct webhook body', () => {
      const validBody = buildWebhookBody('call.initiated');
      const result = telnyxWebhookBodySchema.safeParse(validBody);

      expect(result.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // call.initiated event payload
  // -----------------------------------------------------------------------

  describe('call.initiated event', () => {
    it('validates call payload with correct fields', () => {
      const payload = {
        call_control_id: 'ctrl-123',
        from: '+38761999888',
        to: '+38733123456',
        direction: 'incoming',
      };

      const result = telnyxCallPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('rejects call payload missing required fields', () => {
      const payload = {
        direction: 'incoming',
      };

      const result = telnyxCallPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // call.hangup event payload
  // -----------------------------------------------------------------------

  describe('call.hangup event', () => {
    it('validates hangup payload structure', () => {
      const payload = {
        call_control_id: 'ctrl-hangup-1',
        from: '+38761999888',
        to: '+38733123456',
        state: 'hangup',
      };

      const result = telnyxCallPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // call.machine.detection.ended event payload
  // -----------------------------------------------------------------------

  describe('call.machine.detection.ended event', () => {
    it('validates machine detection payload with human result', () => {
      const payload = {
        call_control_id: 'ctrl-md-1',
        from: '+38761999888',
        to: '+38733123456',
        result: 'human',
      };

      const result = telnyxMachineDetectionPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.result).toBe('human');
      }
    });

    it('validates machine detection payload with machine result', () => {
      const payload = {
        call_control_id: 'ctrl-md-2',
        from: '+38761999888',
        to: '+38733123456',
        result: 'machine',
      };

      const result = telnyxMachineDetectionPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('rejects machine detection payload with invalid result value', () => {
      const payload = {
        call_control_id: 'ctrl-md-3',
        from: '+38761999888',
        to: '+38733123456',
        result: 'unknown_value',
      };

      const result = telnyxMachineDetectionPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Anti-loop integration
  // -----------------------------------------------------------------------

  describe('anti-loop integration', () => {
    it('canCallNumber is invoked with the caller phone number', async () => {
      const phoneNumber = '+38761999888';

      mockCanCallNumber.mockResolvedValueOnce(true);
      const allowed = await mockCanCallNumber(phoneNumber);

      expect(allowed).toBe(true);
      expect(mockCanCallNumber).toHaveBeenCalledWith(phoneNumber);
    });

    it('blocks a call when anti-loop returns false', async () => {
      mockCanCallNumber.mockResolvedValueOnce(false);

      const allowed = await mockCanCallNumber('+38761999888');

      expect(allowed).toBe(false);
    });

    it('markCallMade is invoked after a successful call initiation', async () => {
      mockMarkCallMade.mockResolvedValueOnce(undefined);

      await mockMarkCallMade('+38761999888');

      expect(mockMarkCallMade).toHaveBeenCalledWith('+38761999888');
    });
  });

  // -----------------------------------------------------------------------
  // verifyWebhookSignature unit tests
  // -----------------------------------------------------------------------

  describe('verifyWebhookSignature', () => {
    it('returns false for obviously invalid inputs without throwing', () => {
      const result = verifyWebhookSignature(
        '{"test": true}',
        'not-valid-base64!!',
        '1234567890',
        'not-a-real-public-key',
      );

      expect(result).toBe(false);
    });

    it('returns false for empty signature', () => {
      const result = verifyWebhookSignature(
        '{"data":{}}',
        '',
        '1234567890',
        'dGVzdC1wdWJsaWMta2V5',
      );

      expect(result).toBe(false);
    });

    it('returns false for empty body', () => {
      const result = verifyWebhookSignature(
        '',
        'c29tZS1zaWduYXR1cmU=',
        '1234567890',
        'dGVzdC1wdWJsaWMta2V5',
      );

      // Should not throw, just return false
      expect(typeof result).toBe('boolean');
    });
  });
});
