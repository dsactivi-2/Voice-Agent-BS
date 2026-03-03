import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateAdaptiveDelay } from '../../src/session/adaptive-delay.js';

vi.mock('../../src/config.js', () => ({
  config: {
    ADAPTIVE_DELAY_MIN_MS: 200,
    ADAPTIVE_DELAY_MAX_MS: 800,
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

describe('calculateAdaptiveDelay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds delay for short transcript with fast processing', () => {
    // "Da" = 2 chars (< 10), target = 200ms, actual = 50ms → add 150ms
    const delay = calculateAdaptiveDelay('Da', 50);
    expect(delay).toBe(150);
  });

  it('returns 0 for short transcript when processing was already slow', () => {
    // "Ok" = 2 chars (< 10), target = 200ms, actual = 300ms → no extra delay
    const delay = calculateAdaptiveDelay('Ok', 300);
    expect(delay).toBe(0);
  });

  it('adds delay for medium transcript with fast processing', () => {
    // 15 chars (>= 10, < 30), target = 300ms, actual = 100ms → add 200ms
    const delay = calculateAdaptiveDelay('Koliko to kosta', 100);
    expect(delay).toBe(200);
  });

  it('returns 0 for medium transcript when processing was slow enough', () => {
    // 15 chars (>= 10, < 30), target = 300ms, actual = 500ms → no extra delay
    const delay = calculateAdaptiveDelay('Koliko to kosta', 500);
    expect(delay).toBe(0);
  });

  it('always returns 0 for long/complex transcript', () => {
    // 40 chars (>= 30) → always 0 regardless of actual latency
    const longText = 'Mozete li mi objasniti vise o tom paketu';
    expect(calculateAdaptiveDelay(longText, 10)).toBe(0);
    expect(calculateAdaptiveDelay(longText, 0)).toBe(0);
    expect(calculateAdaptiveDelay(longText, 1000)).toBe(0);
  });

  it('handles empty string as short transcript', () => {
    // 0 chars (< 10), target = 200ms, actual = 0ms → add 200ms
    const delay = calculateAdaptiveDelay('', 0);
    expect(delay).toBe(200);
  });

  it('handles exactly 10 chars as medium transcript', () => {
    // Exactly 10 chars — should be treated as medium (>= 10, < 30)
    const tenChars = 'Halo dobro';
    expect(tenChars.length).toBe(10);
    const delay = calculateAdaptiveDelay(tenChars, 50);
    // target = 300ms, actual = 50ms → add 250ms
    expect(delay).toBe(250);
  });

  it('handles exactly 30 chars as complex transcript', () => {
    // Exactly 30 chars — should be treated as complex (>= 30)
    const thirtyChars = 'Da, to me zanima, recite vise.';
    expect(thirtyChars.length).toBe(30);
    const delay = calculateAdaptiveDelay(thirtyChars, 0);
    expect(delay).toBe(0);
  });

  it('never returns negative values', () => {
    const delay = calculateAdaptiveDelay('Da', 99999);
    expect(delay).toBeGreaterThanOrEqual(0);
  });

  describe('llmMode cap (mini + short transcript)', () => {
    it('caps delay at 200ms for mini mode with short transcript', () => {
      // Medium transcript (15 chars < 60), mini mode → effectiveMax = 200ms
      // target = min(300, 200) = 200, actual = 0 → additional = 200
      const delay = calculateAdaptiveDelay('Koliko to kosta', 0, 'mini');
      expect(delay).toBe(200);
    });

    it('applies full delay for mini mode when transcript >= 60 chars', () => {
      // Long-ish transcript (>= 60 chars) → effectiveMax = 800ms (no cap)
      // But >= 30 chars → complex → always returns 0
      const longText = 'Zanima me vise detalja o tome kako funkcionise vasa usluga i sta dobijam';
      expect(longText.length).toBeGreaterThanOrEqual(60);
      const delay = calculateAdaptiveDelay(longText, 0, 'mini');
      expect(delay).toBe(0); // complex transcript always returns 0
    });

    it('does not cap delay for full mode with short transcript', () => {
      // Same medium transcript, full mode → effectiveMax = 800ms (no cap)
      // target = min(300, 800) = 300, actual = 0 → additional = 300
      const delay = calculateAdaptiveDelay('Koliko to kosta', 0, 'full');
      expect(delay).toBe(300);
    });

    it('does not cap delay when llmMode is undefined', () => {
      // No llmMode → effectiveMax = 800ms
      // target = min(300, 800) = 300, actual = 0 → additional = 300
      const delay = calculateAdaptiveDelay('Koliko to kosta', 0);
      expect(delay).toBe(300);
    });
  });
});
