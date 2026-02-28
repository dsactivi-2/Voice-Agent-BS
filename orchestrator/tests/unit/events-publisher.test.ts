import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPublish } = vi.hoisted(() => ({
  mockPublish: vi.fn(),
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

vi.mock('../../src/cache/redis-client.js', () => ({
  redis: { publish: mockPublish },
}));

import { publishCallEvent, CALL_EVENTS_CHANNEL } from '../../src/events/publisher.js';
import { logger } from '../../src/utils/logger.js';

describe('publishCallEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublish.mockResolvedValue(1);
  });

  it('publishes call.started to the correct channel', async () => {
    await publishCallEvent({
      type: 'call.started',
      callId: 'c1',
      phoneNumber: '+38761111111',
      language: 'bs-BA',
      campaignId: 'camp-1',
      abGroup: 'mini_to_full',
      llmMode: 'mini',
      ts: 1000,
    });

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      CALL_EVENTS_CHANNEL,
      expect.stringContaining('"type":"call.started"'),
    );
    expect(mockPublish).toHaveBeenCalledWith(
      CALL_EVENTS_CHANNEL,
      expect.stringContaining('"callId":"c1"'),
    );
  });

  it('publishes valid JSON for call.started', async () => {
    const event = {
      type: 'call.started' as const,
      callId: 'c2',
      phoneNumber: '+38762222222',
      language: 'sr-RS' as const,
      campaignId: 'camp-2',
      abGroup: 'full_only' as const,
      llmMode: 'full' as const,
      ts: 2000,
    };

    await publishCallEvent(event);

    const payload = (mockPublish.mock.calls[0] as [string, string])[1];
    expect(() => JSON.parse(payload)).not.toThrow();
    expect(JSON.parse(payload)).toMatchObject(event);
  });

  it('publishes call.ended event', async () => {
    await publishCallEvent({ type: 'call.ended', callId: 'c3', result: 'success', ts: 3000 });

    expect(mockPublish).toHaveBeenCalledWith(
      CALL_EVENTS_CHANNEL,
      expect.stringContaining('"type":"call.ended"'),
    );
    expect(mockPublish).toHaveBeenCalledWith(
      CALL_EVENTS_CHANNEL,
      expect.stringContaining('"result":"success"'),
    );
  });

  it('publishes call.turn_completed event', async () => {
    await publishCallEvent({
      type: 'call.turn_completed',
      callId: 'c4',
      turn: 3,
      phase: 'pitch',
      ts: 4000,
    });

    const payload = JSON.parse((mockPublish.mock.calls[0] as [string, string])[1]) as Record<string, unknown>;
    expect(payload.type).toBe('call.turn_completed');
    expect(payload.turn).toBe(3);
    expect(payload.phase).toBe('pitch');
  });

  it('publishes call.phase_changed event', async () => {
    await publishCallEvent({
      type: 'call.phase_changed',
      callId: 'c5',
      from: 'qualify',
      to: 'pitch',
      ts: 5000,
    });

    const payload = JSON.parse((mockPublish.mock.calls[0] as [string, string])[1]) as Record<string, unknown>;
    expect(payload.type).toBe('call.phase_changed');
    expect(payload.from).toBe('qualify');
    expect(payload.to).toBe('pitch');
  });

  it('publishes call.llm_switched event', async () => {
    await publishCallEvent({
      type: 'call.llm_switched',
      callId: 'c6',
      from: 'mini',
      to: 'full',
      ts: 6000,
    });

    const payload = JSON.parse((mockPublish.mock.calls[0] as [string, string])[1]) as Record<string, unknown>;
    expect(payload.type).toBe('call.llm_switched');
    expect(payload.from).toBe('mini');
    expect(payload.to).toBe('full');
  });

  it('does not throw when redis.publish rejects', async () => {
    mockPublish.mockRejectedValue(new Error('Redis connection failed'));

    await expect(
      publishCallEvent({ type: 'call.ended', callId: 'c7', result: 'error', ts: 7000 }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'call.ended' }),
      expect.stringContaining('Failed to publish'),
    );
  });

  it('publishes to CALL_EVENTS_CHANNEL constant', () => {
    expect(CALL_EVENTS_CHANNEL).toBe('call-events');
  });
});
