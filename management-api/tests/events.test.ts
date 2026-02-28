import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventStreamManager } from '../src/services/event-stream.js';
import type { CallEvent } from '../src/services/event-stream.js';
import type { ServerResponse } from 'node:http';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockRes(): ServerResponse {
  return {
    write: vi.fn().mockReturnValue(true),
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    on: vi.fn(),
  } as unknown as ServerResponse;
}

// ─── EventStreamManager ───────────────────────────────────────────────────────

describe('EventStreamManager', () => {
  let manager: EventStreamManager;

  beforeEach(() => {
    manager = new EventStreamManager();
    vi.clearAllMocks();
  });

  it('starts with zero connections', () => {
    expect(manager.connectionCount).toBe(0);
  });

  it('adds a client and increments connectionCount', () => {
    const res = makeMockRes();
    manager.addClient(res);
    expect(manager.connectionCount).toBe(1);
  });

  it('removes a client and decrements connectionCount', () => {
    const res = makeMockRes();
    manager.addClient(res);
    manager.removeClient(res);
    expect(manager.connectionCount).toBe(0);
  });

  it('removing unknown client is a no-op', () => {
    const res = makeMockRes();
    expect(() => manager.removeClient(res)).not.toThrow();
    expect(manager.connectionCount).toBe(0);
  });

  it('broadcasts to all unfiltered clients', () => {
    const res1 = makeMockRes();
    const res2 = makeMockRes();
    manager.addClient(res1);
    manager.addClient(res2);

    const event: CallEvent = { type: 'call.ended', callId: 'c1', result: 'success', ts: 1000 };
    manager.broadcast(event);

    expect(res1.write).toHaveBeenCalledTimes(1);
    expect(res2.write).toHaveBeenCalledTimes(1);
    expect((res1.write as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('"type":"call.ended"');
  });

  it('filters events to matching callId client', () => {
    const resA = makeMockRes();
    const resB = makeMockRes();
    manager.addClient(resA, 'call-A');
    manager.addClient(resB, 'call-B');

    const event: CallEvent = { type: 'call.ended', callId: 'call-A', result: 'success', ts: 2000 };
    manager.broadcast(event);

    expect(resA.write).toHaveBeenCalledTimes(1);
    expect(resB.write).not.toHaveBeenCalled();
  });

  it('sends to unfiltered clients regardless of event callId', () => {
    const unfilteredRes = makeMockRes();
    const filteredRes = makeMockRes();
    manager.addClient(unfilteredRes); // no filter
    manager.addClient(filteredRes, 'call-X');

    const event: CallEvent = { type: 'call.ended', callId: 'call-Y', result: 'no_answer', ts: 3000 };
    manager.broadcast(event);

    expect(unfilteredRes.write).toHaveBeenCalledTimes(1);
    expect(filteredRes.write).not.toHaveBeenCalled();
  });

  it('formats message as valid SSE data line', () => {
    const res = makeMockRes();
    manager.addClient(res);

    const event: CallEvent = { type: 'call.started', callId: 'c2', phoneNumber: '+1', language: 'bs-BA', campaignId: 'camp', abGroup: 'mini_only', llmMode: 'mini', ts: 4000 };
    manager.broadcast(event);

    const written = (res.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written).toMatch(/^data: /);
    expect(written).toMatch(/\n\n$/);

    const jsonPart = written.replace(/^data: /, '').replace(/\n\n$/, '');
    expect(() => JSON.parse(jsonPart)).not.toThrow();
    expect(JSON.parse(jsonPart)).toMatchObject({ type: 'call.started', callId: 'c2' });
  });

  it('removes erroring client from set on write failure', () => {
    const res = makeMockRes();
    (res.write as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('socket closed'); });
    manager.addClient(res);

    const event: CallEvent = { type: 'call.ended', callId: 'c3', result: 'error', ts: 5000 };
    manager.broadcast(event);

    expect(manager.connectionCount).toBe(0);
  });

  it('supports multiple clients for same callId', () => {
    const res1 = makeMockRes();
    const res2 = makeMockRes();
    manager.addClient(res1, 'call-Z');
    manager.addClient(res2, 'call-Z');

    const event: CallEvent = { type: 'call.phase_changed', callId: 'call-Z', from: 'hook', to: 'qualify', ts: 6000 };
    manager.broadcast(event);

    expect(res1.write).toHaveBeenCalledTimes(1);
    expect(res2.write).toHaveBeenCalledTimes(1);
  });

  it('broadcasts all event types correctly', () => {
    const res = makeMockRes();
    manager.addClient(res);

    const events: CallEvent[] = [
      { type: 'call.started', callId: 'c', phoneNumber: '+1', language: 'bs-BA', campaignId: 'x', abGroup: 'mini_only', llmMode: 'mini', ts: 1 },
      { type: 'call.turn_completed', callId: 'c', turn: 1, phase: 'hook', ts: 2 },
      { type: 'call.phase_changed', callId: 'c', from: 'hook', to: 'qualify', ts: 3 },
      { type: 'call.llm_switched', callId: 'c', from: 'mini', to: 'full', ts: 4 },
      { type: 'call.ended', callId: 'c', result: 'success', ts: 5 },
    ];

    for (const event of events) {
      manager.broadcast(event);
    }

    expect(res.write).toHaveBeenCalledTimes(5);
  });
});

// ─── SSE Route: auth guard ─────────────────────────────────────────────────────

describe('GET /api/events auth guard', () => {
  async function buildApp() {
    const { default: Fastify } = await import('fastify');
    const { default: cors } = await import('@fastify/cors');
    const { default: helmet } = await import('@fastify/helmet');
    const { default: rateLimit } = await import('@fastify/rate-limit');
    const { eventRoutes } = await import('../src/routes/events.js');

    const fastify = Fastify({ logger: false, trustProxy: true });
    await fastify.register(cors, { origin: true });
    await fastify.register(helmet, { contentSecurityPolicy: false });
    await fastify.register(rateLimit, { global: false, max: 100, timeWindow: '1 minute' });
    await fastify.register(eventRoutes);
    await fastify.ready();
    return fastify;
  }

  it('returns 401 when Authorization header is missing', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/events' });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body.code).toBe('MISSING_TOKEN');
    await app.close();
  });

  it('returns 401 when token is invalid', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/events',
      headers: { Authorization: 'Bearer invalid-token' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
