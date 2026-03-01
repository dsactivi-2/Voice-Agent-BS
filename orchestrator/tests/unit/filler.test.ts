import { describe, it, expect, vi, beforeEach } from 'vitest';
import { selectFiller, getFillerPhrase } from '../../src/filler.js';
import type { AgentConfig, CallSession, FillerType } from '../../src/types.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

/** Creates a minimal CallSession for testing. */
function createSession(overrides: Partial<CallSession> = {}): CallSession {
  return {
    callId: 'test-call-1',
    phoneNumber: '+38761000000',
    language: 'bs-BA',
    llmMode: 'full',
    interestScores: [],
    complexityScore: 0,
    phase: 'hook',
    campaignId: 'campaign-1',
    abGroup: 'full_only',
    startedAt: new Date(),
    turnCount: 0,
    conversationSummary: '',
    structuredMemory: {
      objections: [],
      tone: 'neutral',
      microCommitment: false,
    },
    callerSpokeRecently: false,
    ...overrides,
  };
}

/** Creates a minimal AgentConfig with a filler library. */
function createAgent(fillerLibrary?: Partial<Record<FillerType, string[]>>): AgentConfig {
  return {
    language: 'bs-BA',
    telnyxPhoneNumber: '+38761000001',
    deepgramLanguage: 'bs',
    ttsVoice: 'bs-BA-GoranNeural',
    systemPrompt: 'Test prompt',
    fillerLibrary: {
      acknowledge: fillerLibrary?.acknowledge ?? ['Razumijem.', 'Da, da.', 'Aha.'],
      thinking: fillerLibrary?.thinking ?? ['Hajde da vidimo...', 'Dajte da provjerim...'],
      affirm: fillerLibrary?.affirm ?? ['Odlicno!', 'Super!', 'Sjajno!'],
    },
    cachedPhrases: {},
  };
}

describe('selectFiller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for mini LLM mode with short text', () => {
    const session = createSession({ llmMode: 'mini' });
    const result = selectFiller(session, 'Da');
    expect(result).toBeNull();
  });

  it('returns null for mini LLM mode with text up to 60 chars', () => {
    const session = createSession({ llmMode: 'mini' });
    // 24 chars — well within the 60-char threshold
    const result = selectFiller(session, 'Koliko to kosta mjesecno');
    expect(result).toBeNull();
  });

  it('returns filler for mini LLM mode with text over 60 chars', () => {
    const session = createSession({ llmMode: 'mini' });
    // 65 chars — exceeds the 60-char threshold so filler is needed
    const result = selectFiller(session, 'Mozete li mi objasniti malo vise o vasoj usluzi i uslovima rada');
    expect(result).not.toBeNull();
  });

  it('returns thinking for questions (ends with ?)', () => {
    const session = createSession({ llmMode: 'full' });
    const result = selectFiller(session, 'Koliko to kosta?');
    expect(result).toBe('thinking');
  });

  it('returns affirm for affirmation words', () => {
    const session = createSession({ llmMode: 'full' });

    expect(selectFiller(session, 'Da')).toBe('affirm');
    expect(selectFiller(session, 'ok')).toBe('affirm');
    expect(selectFiller(session, 'dobro')).toBe('affirm');
    expect(selectFiller(session, 'naravno')).toBe('affirm');
    expect(selectFiller(session, 'moze')).toBe('affirm');
  });

  it('returns acknowledge as default for full LLM mode', () => {
    const session = createSession({ llmMode: 'full' });
    const result = selectFiller(session, 'Imam pitanje o vasem paketu');
    expect(result).toBe('acknowledge');
  });

  it('returns null for empty transcript', () => {
    const session = createSession({ llmMode: 'full' });
    const result = selectFiller(session, '');
    expect(result).toBeNull();
  });

  it('returns null for whitespace-only transcript', () => {
    const session = createSession({ llmMode: 'full' });
    const result = selectFiller(session, '   ');
    expect(result).toBeNull();
  });
});

describe('getFillerPhrase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a phrase from the correct filler type', () => {
    const agent = createAgent();
    const phrase = getFillerPhrase(agent, 'acknowledge');
    expect(agent.fillerLibrary.acknowledge).toContain(phrase);
  });

  it('returns a phrase for thinking type', () => {
    const agent = createAgent();
    const phrase = getFillerPhrase(agent, 'thinking');
    expect(agent.fillerLibrary.thinking).toContain(phrase);
  });

  it('returns a phrase for affirm type', () => {
    const agent = createAgent();
    const phrase = getFillerPhrase(agent, 'affirm');
    expect(agent.fillerLibrary.affirm).toContain(phrase);
  });

  it('throws when filler library is empty for the requested type', () => {
    const agent = createAgent({ acknowledge: [] });
    expect(() => getFillerPhrase(agent, 'acknowledge')).toThrow(
      'No filler phrases available for type: acknowledge',
    );
  });

  it('returns the only available phrase when library has one entry', () => {
    const agent = createAgent({ thinking: ['Hmm...'] });
    const phrase = getFillerPhrase(agent, 'thinking');
    expect(phrase).toBe('Hmm...');
  });
});
