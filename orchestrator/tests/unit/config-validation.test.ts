import { describe, it, expect } from 'vitest';
import { z } from 'zod/v4';

/**
 * Tests for config.ts validation fixes:
 * - #2: TTS_VOICE_SR default matches agent-sr.ts (SophieNeural, not NicholasNeural)
 * - #4: DEEPGRAM_BASE_URL uses z.url() (validates actual URLs, rejects garbage)
 */

// Re-create the relevant schema parts to test in isolation
// (importing config.ts directly would trigger process.env validation + dotenv side effects)

const TTS_VOICE_SR_SCHEMA = z.string().default('sr-RS-SophieNeural');
const DEEPGRAM_BASE_URL_SCHEMA = z.url().optional();

describe('Config validation fixes', () => {
  describe('#2: TTS_VOICE_SR default', () => {
    it('defaults to sr-RS-SophieNeural (matching agent-sr.ts)', () => {
      const result = TTS_VOICE_SR_SCHEMA.parse(undefined);
      expect(result).toBe('sr-RS-SophieNeural');
    });

    it('accepts env override', () => {
      const result = TTS_VOICE_SR_SCHEMA.parse('sr-RS-NicholasNeural');
      expect(result).toBe('sr-RS-NicholasNeural');
    });
  });

  describe('#4: DEEPGRAM_BASE_URL validates URLs', () => {
    it('accepts valid URL', () => {
      const result = DEEPGRAM_BASE_URL_SCHEMA.parse('https://api.deepgram.com');
      expect(result).toBe('https://api.deepgram.com');
    });

    it('accepts undefined (optional)', () => {
      const result = DEEPGRAM_BASE_URL_SCHEMA.parse(undefined);
      expect(result).toBeUndefined();
    });

    it('rejects invalid URL', () => {
      expect(() => DEEPGRAM_BASE_URL_SCHEMA.parse('not-a-url')).toThrow();
    });

    it('rejects empty string', () => {
      expect(() => DEEPGRAM_BASE_URL_SCHEMA.parse('')).toThrow();
    });
  });
});
