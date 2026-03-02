import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — hoisted before any module imports
// ---------------------------------------------------------------------------

vi.mock('../../src/config.js', () => ({
  config: {
    TELNYX_PHONE_BS: '+38733123456',
    TELNYX_PHONE_SR: '+381111234567',
    VONAGE_PHONE_NUMBER: '+4915112345678',
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

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import { routeByPhoneNumber, routeByLanguage } from '../../src/agents/language-router.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('routeByPhoneNumber', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes the Bosnian phone number to the BS agent config', () => {
    const agent = routeByPhoneNumber('+38733123456');

    expect(agent.language).toBe('bs-BA');
    expect(agent.deepgramLanguage).toBe('bs');
    expect(agent.ttsVoice).toBe('bs-BA-GoranNeural');
    expect(agent.telnyxPhoneNumber).toBe('+38733123456');
  });

  it('routes the Serbian phone number to the SR agent config', () => {
    const agent = routeByPhoneNumber('+381111234567');

    expect(agent.language).toBe('sr-RS');
    expect(agent.deepgramLanguage).toBe('sr');
    expect(agent.ttsVoice).toBe('sr-RS-SophieNeural');
    expect(agent.telnyxPhoneNumber).toBe('+381111234567');
  });

  it('throws an error for an unknown phone number', () => {
    expect(() => routeByPhoneNumber('+1555999888')).toThrow(
      'No agent configured for phone number: +1555999888',
    );
  });

  it('normalises phone numbers with dashes and spaces before matching', () => {
    // The BS number with dashes and spaces should still match
    const agent = routeByPhoneNumber('+387 33 123456');

    expect(agent.language).toBe('bs-BA');
  });

  it('normalises phone numbers with parentheses before matching', () => {
    const agent = routeByPhoneNumber('+381-(11)-1234567');

    expect(agent.language).toBe('sr-RS');
  });

  it('routes the Vonage DE number to the BS agent (Goran)', () => {
    const agent = routeByPhoneNumber('+4915112345678');

    expect(agent.language).toBe('bs-BA');
    expect(agent.deepgramLanguage).toBe('bs');
    expect(agent.ttsVoice).toBe('bs-BA-GoranNeural');
  });

  it('returns a complete AgentConfig with all required fields for BS', () => {
    const agent = routeByPhoneNumber('+38733123456');

    expect(agent).toHaveProperty('language');
    expect(agent).toHaveProperty('telnyxPhoneNumber');
    expect(agent).toHaveProperty('deepgramLanguage');
    expect(agent).toHaveProperty('ttsVoice');
    expect(agent).toHaveProperty('systemPrompt');
    expect(agent).toHaveProperty('fillerLibrary');
    expect(agent).toHaveProperty('cachedPhrases');

    // Verify filler library has all required keys
    expect(agent.fillerLibrary).toHaveProperty('acknowledge');
    expect(agent.fillerLibrary).toHaveProperty('thinking');
    expect(agent.fillerLibrary).toHaveProperty('affirm');

    // Verify arrays are non-empty
    expect(agent.fillerLibrary.acknowledge.length).toBeGreaterThan(0);
    expect(agent.fillerLibrary.thinking.length).toBeGreaterThan(0);
    expect(agent.fillerLibrary.affirm.length).toBeGreaterThan(0);
  });

  it('returns a complete AgentConfig with all required fields for SR (routeByPhoneNumber)', () => {
    const agent = routeByPhoneNumber('+381111234567');

    expect(agent.systemPrompt).toBeTruthy();
    expect(agent.systemPrompt.length).toBeGreaterThan(100);
    expect(agent.cachedPhrases).toHaveProperty('intro');
    expect(agent.cachedPhrases).toHaveProperty('goodbye');
    expect(agent.cachedPhrases).toHaveProperty('repeat');
    expect(agent.cachedPhrases).toHaveProperty('still_there');
    expect(agent.cachedPhrases).toHaveProperty('silence_followup');
  });
});

describe('routeByLanguage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns BS agent for bs-BA', () => {
    const agent = routeByLanguage('bs-BA');

    expect(agent.language).toBe('bs-BA');
    expect(agent.ttsVoice).toBe('bs-BA-GoranNeural');
    expect(agent.deepgramLanguage).toBe('bs');
  });

  it('returns SR agent for sr-RS', () => {
    const agent = routeByLanguage('sr-RS');

    expect(agent.language).toBe('sr-RS');
    expect(agent.ttsVoice).toBe('sr-RS-SophieNeural');
    expect(agent.deepgramLanguage).toBe('sr');
  });

  it('returns a complete AgentConfig for bs-BA', () => {
    const agent = routeByLanguage('bs-BA');

    expect(agent).toHaveProperty('systemPrompt');
    expect(agent).toHaveProperty('fillerLibrary');
    expect(agent).toHaveProperty('cachedPhrases');
    expect(agent.systemPrompt.length).toBeGreaterThan(100);
  });

  it('returns a complete AgentConfig for sr-RS', () => {
    const agent = routeByLanguage('sr-RS');

    expect(agent).toHaveProperty('systemPrompt');
    expect(agent.cachedPhrases).toHaveProperty('intro');
    expect(agent.cachedPhrases).toHaveProperty('goodbye');
  });
});
