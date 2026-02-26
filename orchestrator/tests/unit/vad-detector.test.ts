import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VADDetector, calculateRMS } from '../../src/vad/detector.js';

vi.mock('../../src/config.js', () => ({
  config: {
    VAD_BARGE_IN_MIN_MS: 150,
    VAD_GRACE_MS: 200,
  },
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

/**
 * Creates a PCM 16-bit LE buffer filled with a sine wave at the given
 * amplitude. Amplitude 0..1 maps to 0..32767 in 16-bit space.
 */
function createAudioChunk(amplitude: number, samples: number = 160): Buffer {
  const buffer = Buffer.alloc(samples * 2); // 16-bit = 2 bytes per sample
  for (let i = 0; i < samples; i++) {
    const value = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * i) / samples));
    buffer.writeInt16LE(value, i * 2);
  }
  return buffer;
}

/** Creates a completely silent audio chunk (all zeros). */
function createSilentChunk(samples: number = 160): Buffer {
  return Buffer.alloc(samples * 2);
}

describe('calculateRMS', () => {
  it('returns 0 for a silent buffer', () => {
    const silent = createSilentChunk();
    expect(calculateRMS(silent)).toBe(0);
  });

  it('returns 0 for an empty buffer', () => {
    expect(calculateRMS(Buffer.alloc(0))).toBe(0);
  });

  it('returns a positive value for a loud buffer', () => {
    const loud = createAudioChunk(0.5);
    expect(calculateRMS(loud)).toBeGreaterThan(0);
  });

  it('returns higher RMS for higher amplitude', () => {
    const soft = createAudioChunk(0.1);
    const loud = createAudioChunk(0.8);
    expect(calculateRMS(loud)).toBeGreaterThan(calculateRMS(soft));
  });
});

describe('VADDetector', () => {
  let detector: VADDetector;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    detector?.destroy();
    vi.useRealTimers();
  });

  it('does not emit speechStart for silent audio', () => {
    detector = new VADDetector({ energyThreshold: 0.01 });
    const speechStartSpy = vi.fn();
    detector.on('speechStart', speechStartSpy);

    // Feed several silent chunks
    for (let i = 0; i < 20; i++) {
      detector.processAudio(createSilentChunk());
      vi.advanceTimersByTime(10);
    }

    expect(speechStartSpy).not.toHaveBeenCalled();
  });

  it('emits silence event for silent audio chunks', () => {
    detector = new VADDetector({ energyThreshold: 0.01 });
    const silenceSpy = vi.fn();
    detector.on('silence', silenceSpy);

    detector.processAudio(createSilentChunk());
    expect(silenceSpy).toHaveBeenCalledTimes(1);
  });

  it('emits speechStart after speech exceeds minSpeechDuration', () => {
    detector = new VADDetector({
      energyThreshold: 0.005,
      minSpeechDurationMs: 150,
    });
    const speechStartSpy = vi.fn();
    detector.on('speechStart', speechStartSpy);

    // Feed loud audio over 200ms (20 chunks at 10ms each)
    for (let i = 0; i < 20; i++) {
      detector.processAudio(createAudioChunk(0.5));
      vi.advanceTimersByTime(10);
    }

    expect(speechStartSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores short noise bursts below minSpeechDuration', () => {
    detector = new VADDetector({
      energyThreshold: 0.005,
      minSpeechDurationMs: 150,
    });
    const speechStartSpy = vi.fn();
    detector.on('speechStart', speechStartSpy);

    // Feed loud audio for only 100ms (10 chunks at 10ms each)
    for (let i = 0; i < 10; i++) {
      detector.processAudio(createAudioChunk(0.5));
      vi.advanceTimersByTime(10);
    }

    // Then silence — should not have emitted speechStart
    detector.processAudio(createSilentChunk());
    vi.advanceTimersByTime(10);

    expect(speechStartSpy).not.toHaveBeenCalled();
    expect(detector.getState()).toBe('idle');
  });

  it('emits speechEnd after grace period following confirmed speech', () => {
    detector = new VADDetector({
      energyThreshold: 0.005,
      minSpeechDurationMs: 50,
      gracePeriodMs: 100,
    });
    const speechEndSpy = vi.fn();
    detector.on('speechEnd', speechEndSpy);

    // Speak for 100ms to trigger speechStart
    for (let i = 0; i < 10; i++) {
      detector.processAudio(createAudioChunk(0.5));
      vi.advanceTimersByTime(10);
    }

    // Now go silent — enter grace period
    detector.processAudio(createSilentChunk());
    vi.advanceTimersByTime(10);

    // speechEnd should not fire yet (grace period is 100ms)
    expect(speechEndSpy).not.toHaveBeenCalled();

    // Advance past grace period
    vi.advanceTimersByTime(100);

    expect(speechEndSpy).toHaveBeenCalledTimes(1);
    expect(speechEndSpy).toHaveBeenCalledWith(expect.any(Number));
  });

  it('cancels speechEnd if speech resumes during grace period', () => {
    detector = new VADDetector({
      energyThreshold: 0.005,
      minSpeechDurationMs: 50,
      gracePeriodMs: 200,
    });
    const speechEndSpy = vi.fn();
    detector.on('speechEnd', speechEndSpy);

    // Speak to trigger speechStart
    for (let i = 0; i < 10; i++) {
      detector.processAudio(createAudioChunk(0.5));
      vi.advanceTimersByTime(10);
    }

    // Brief silence (50ms — within grace period)
    detector.processAudio(createSilentChunk());
    vi.advanceTimersByTime(50);

    // Resume speech
    detector.processAudio(createAudioChunk(0.5));
    vi.advanceTimersByTime(10);

    // Wait well past the original grace period
    vi.advanceTimersByTime(300);

    // speechEnd should not have fired (speech resumed)
    expect(speechEndSpy).not.toHaveBeenCalled();
    expect(detector.getState()).toBe('speaking');
  });

  it('reset clears state and returns to idle', () => {
    detector = new VADDetector({
      energyThreshold: 0.005,
      minSpeechDurationMs: 50,
    });

    // Start speaking
    for (let i = 0; i < 10; i++) {
      detector.processAudio(createAudioChunk(0.5));
      vi.advanceTimersByTime(10);
    }
    expect(detector.getState()).toBe('speaking');

    // Reset
    detector.reset();
    expect(detector.getState()).toBe('idle');

    // Should not emit speechEnd after reset
    const speechEndSpy = vi.fn();
    detector.on('speechEnd', speechEndSpy);
    vi.advanceTimersByTime(500);
    expect(speechEndSpy).not.toHaveBeenCalled();
  });

  it('does not emit events after destroy', () => {
    detector = new VADDetector({ energyThreshold: 0.005 });
    const speechStartSpy = vi.fn();
    detector.on('speechStart', speechStartSpy);

    detector.destroy();

    // Process audio after destruction — should be ignored
    for (let i = 0; i < 20; i++) {
      detector.processAudio(createAudioChunk(0.5));
      vi.advanceTimersByTime(10);
    }

    expect(speechStartSpy).not.toHaveBeenCalled();
  });

  it('transitions through full lifecycle: idle → speaking → grace → idle', () => {
    detector = new VADDetector({
      energyThreshold: 0.005,
      minSpeechDurationMs: 30,
      gracePeriodMs: 50,
    });

    const speechStartSpy = vi.fn();
    const speechEndSpy = vi.fn();
    detector.on('speechStart', speechStartSpy);
    detector.on('speechEnd', speechEndSpy);

    expect(detector.getState()).toBe('idle');

    // Start speaking
    for (let i = 0; i < 5; i++) {
      detector.processAudio(createAudioChunk(0.5));
      vi.advanceTimersByTime(10);
    }
    expect(detector.getState()).toBe('speaking');
    expect(speechStartSpy).toHaveBeenCalledTimes(1);

    // Go silent — enters grace period
    detector.processAudio(createSilentChunk());
    vi.advanceTimersByTime(10);
    expect(detector.getState()).toBe('grace_period');

    // Grace period expires
    vi.advanceTimersByTime(50);
    expect(detector.getState()).toBe('idle');
    expect(speechEndSpy).toHaveBeenCalledTimes(1);
  });
});
