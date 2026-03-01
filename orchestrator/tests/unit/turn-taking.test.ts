import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    VAD_BARGE_IN_MIN_MS: 150,
    VAD_SILENCE_TIMEOUT_MS: 10000,
    SILENCE_PRESSURE_AFTER_OFFER_MS: 2500,
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

// Import after mocks are set up
import { TurnTakingManager } from '../../src/vad/turn-taking.js';

/**
 * Minimal stub that satisfies the VADDetector event interface
 * without importing EventEmitter in a hoisted context.
 */
class StubVADDetector {
  private readonly _listeners: Map<string, ((...args: unknown[]) => void)[]> = new Map();

  on(event: string, handler: (...args: unknown[]) => void): this {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(handler);
    return this;
  }

  off(event: string, handler: (...args: unknown[]) => void): this {
    const handlers = this._listeners.get(event) ?? [];
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    (this._listeners.get(event) ?? []).forEach((h) => h(...args));
  }

  destroy = vi.fn();
  processAudio = vi.fn();
  getState = vi.fn(() => 'idle');
}

function createManager(options: ConstructorParameters<typeof TurnTakingManager>[1] = {}) {
  const vad = new StubVADDetector();
  const manager = new TurnTakingManager(
    vad as unknown as import('../../src/vad/detector.js').VADDetector,
    { silenceTimeoutMs: 30000, ...options },
  );
  return { manager, vad };
}

describe('TurnTakingManager — basic flow', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('emits userFinishedSpeaking when final transcript arrives before speechEnd', () => {
    const { manager, vad } = createManager();
    const spy = vi.fn();
    manager.on('userFinishedSpeaking', spy);

    vad.emit('speechStart');
    // Final arrives while user is still speaking → buffered
    manager.onTranscriptReceived(true, 'Zdravo, zanima me');
    // VAD: user stops → buffered final is emitted
    vad.emit('speechEnd', 500);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('Zdravo, zanima me');

    manager.destroy();
  });

  it('emits userFinishedSpeaking when speechEnd arrives before final transcript', () => {
    const { manager, vad } = createManager();
    const spy = vi.fn();
    manager.on('userFinishedSpeaking', spy);

    vad.emit('speechStart');
    vad.emit('speechEnd', 300);

    // Not emitted yet — waiting for final
    expect(spy).not.toHaveBeenCalled();

    // Deepgram delivers final
    manager.onTranscriptReceived(true, 'Ne mogu sad');
    expect(spy).toHaveBeenCalledWith('Ne mogu sad');

    manager.destroy();
  });

  it('ignores empty final transcripts', () => {
    const { manager, vad } = createManager();
    const spy = vi.fn();
    manager.on('userFinishedSpeaking', spy);

    vad.emit('speechStart');
    manager.onTranscriptReceived(true, '   ');
    vad.emit('speechEnd', 200);

    expect(spy).not.toHaveBeenCalled();
    manager.destroy();
  });

  it('ignores interim transcripts for turn signalling', () => {
    const { manager, vad } = createManager();
    const spy = vi.fn();
    manager.on('userFinishedSpeaking', spy);

    vad.emit('speechStart');
    manager.onTranscriptReceived(false, 'Partial text');

    expect(spy).not.toHaveBeenCalled();
    manager.destroy();
  });
});

describe('TurnTakingManager — H1: final transcript timeout fallback', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('uses last interim as fallback when final never arrives after speechEnd', () => {
    const { manager, vad } = createManager();
    const spy = vi.fn();
    manager.on('userFinishedSpeaking', spy);

    vad.emit('speechStart');
    // Deepgram sends interim but never sends final
    manager.onTranscriptReceived(false, 'ne zanima me');
    vad.emit('speechEnd', 400);

    // Not emitted yet
    expect(spy).not.toHaveBeenCalled();

    // 3s safety timer fires
    vi.advanceTimersByTime(3001);

    // Should fall back to the interim transcript
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('ne zanima me');

    manager.destroy();
  });

  it('does not emit when timeout fires with no usable interim and restarts silence monitor', () => {
    const { manager, vad } = createManager({ silenceTimeoutMs: 5000 });
    const finishedSpy = vi.fn();
    const silenceSpy = vi.fn();
    manager.on('userFinishedSpeaking', finishedSpy);
    manager.on('silenceTimeout', silenceSpy);

    vad.emit('speechStart');
    // No interim received
    vad.emit('speechEnd', 200);

    // 3s timeout
    vi.advanceTimersByTime(3001);

    // No turn fired
    expect(finishedSpy).not.toHaveBeenCalled();

    // Silence monitor was restarted — fires after 5s
    vi.advanceTimersByTime(5001);
    expect(silenceSpy).toHaveBeenCalledWith('ask');

    manager.destroy();
  });

  it('ignores interim shorter than 4 characters', () => {
    const { manager, vad } = createManager();
    const spy = vi.fn();
    manager.on('userFinishedSpeaking', spy);

    vad.emit('speechStart');
    manager.onTranscriptReceived(false, 'mm'); // 2 chars — too short
    vad.emit('speechEnd', 100);

    vi.advanceTimersByTime(3001);

    expect(spy).not.toHaveBeenCalled();
    manager.destroy();
  });

  it('clears interim after a successful final — no stale data in next turn', () => {
    const { manager, vad } = createManager();
    const spy = vi.fn();
    manager.on('userFinishedSpeaking', spy);

    // Turn 1: interim + final → final wins
    vad.emit('speechStart');
    manager.onTranscriptReceived(false, 'staro interim koje ne bi smjelo ostati');
    manager.onTranscriptReceived(true, 'prihvatam ponudu');
    vad.emit('speechEnd', 400);

    expect(spy).toHaveBeenCalledWith('prihvatam ponudu');
    spy.mockClear();

    // Turn 2: no interim, speechEnd without final → timeout should NOT use old interim
    vad.emit('speechStart');
    vad.emit('speechEnd', 200);

    vi.advanceTimersByTime(3001);

    expect(spy).not.toHaveBeenCalled();
    manager.destroy();
  });

  it('late-arriving final after timeout is buffered, not double-emitted', () => {
    const { manager, vad } = createManager();
    const spy = vi.fn();
    manager.on('userFinishedSpeaking', spy);

    vad.emit('speechStart');
    manager.onTranscriptReceived(false, 'ne mogu prisustvovati');
    vad.emit('speechEnd', 300);

    // Timeout fires — emits fallback
    vi.advanceTimersByTime(3001);
    expect(spy).toHaveBeenCalledTimes(1);

    // Late-arriving final (Deepgram was slow) — waitingForFinal is already false
    // It gets buffered to pendingFinalTranscript, no extra emit
    manager.onTranscriptReceived(true, 'ne mogu prisustvovati sastanku');
    expect(spy).toHaveBeenCalledTimes(1);

    manager.destroy();
  });
});

describe('TurnTakingManager — barge-in', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('emits bargeIn when user speaks while bot is playing', () => {
    const { manager, vad } = createManager({ bargeInMinMs: 0 });
    const spy = vi.fn();
    manager.on('bargeIn', spy);

    manager.setBotSpeaking(true);
    vad.emit('speechStart');

    expect(spy).toHaveBeenCalledTimes(1);
    manager.destroy();
  });

  it('does not emit bargeIn when bot is not speaking', () => {
    const { manager, vad } = createManager({ bargeInMinMs: 0 });
    const spy = vi.fn();
    manager.on('bargeIn', spy);

    manager.setBotSpeaking(false);
    vad.emit('speechStart');

    expect(spy).not.toHaveBeenCalled();
    manager.destroy();
  });
});

describe('TurnTakingManager — reset', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('clears interim transcript on reset', () => {
    const { manager, vad } = createManager();
    const spy = vi.fn();
    manager.on('userFinishedSpeaking', spy);

    vad.emit('speechStart');
    manager.onTranscriptReceived(false, 'text before reset');
    vad.emit('speechEnd', 200);

    // Reset before timeout
    manager.reset();

    // Timeout fires but manager was reset — should not emit with stale interim
    vi.advanceTimersByTime(3001);
    expect(spy).not.toHaveBeenCalled();

    manager.destroy();
  });
});
