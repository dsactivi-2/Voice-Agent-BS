import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createCallSession,
  getNextPhase,
  checkCallDuration,
  hasObjection,
  hasAgreement,
  MAX_CALL_DURATION_MS,
} from '../../src/session/call-session.js';
import type { CallSession, Phase } from '../../src/types.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

/** Creates a minimal CallSession for testing. */
function createMockSession(overrides: Partial<CallSession> = {}): CallSession {
  return {
    callId: 'test-call-1',
    phoneNumber: '+38761000000',
    language: 'bs-BA',
    llmMode: 'mini',
    interestScores: [],
    complexityScore: 0,
    phase: 'hook',
    campaignId: 'campaign-1',
    abGroup: 'mini_to_full',
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

describe('createCallSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets correct default values', () => {
    const session = createCallSession({
      callId: 'call-123',
      phoneNumber: '+38761111111',
      language: 'bs-BA',
      campaignId: 'camp-1',
      abGroup: 'mini_to_full',
      initialLLMMode: 'mini',
    });

    expect(session.callId).toBe('call-123');
    expect(session.phoneNumber).toBe('+38761111111');
    expect(session.language).toBe('bs-BA');
    expect(session.llmMode).toBe('mini');
    expect(session.phase).toBe('hook');
    expect(session.campaignId).toBe('camp-1');
    expect(session.abGroup).toBe('mini_to_full');
    expect(session.interestScores).toEqual([]);
    expect(session.complexityScore).toBe(0);
    expect(session.turnCount).toBe(0);
    expect(session.conversationSummary).toBe('');
    expect(session.callerSpokeRecently).toBe(false);
  });

  it('sets structured memory defaults', () => {
    const session = createCallSession({
      callId: 'call-123',
      phoneNumber: '+38761111111',
      language: 'sr-RS',
      campaignId: 'camp-1',
      abGroup: 'full_only',
      initialLLMMode: 'full',
    });

    expect(session.structuredMemory.objections).toEqual([]);
    expect(session.structuredMemory.tone).toBe('neutral');
    expect(session.structuredMemory.microCommitment).toBe(false);
    expect(session.structuredMemory.customerName).toBeUndefined();
  });

  it('sets startedAt to a recent timestamp', () => {
    const before = Date.now();
    const session = createCallSession({
      callId: 'call-123',
      phoneNumber: '+38761111111',
      language: 'bs-BA',
      campaignId: 'camp-1',
      abGroup: 'mini_only',
      initialLLMMode: 'mini',
    });
    const after = Date.now();

    expect(session.startedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(session.startedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it('respects full_only AB group with full LLM mode', () => {
    const session = createCallSession({
      callId: 'call-456',
      phoneNumber: '+38761222222',
      language: 'sr-RS',
      campaignId: 'camp-2',
      abGroup: 'full_only',
      initialLLMMode: 'full',
    });

    expect(session.abGroup).toBe('full_only');
    expect(session.llmMode).toBe('full');
  });
});

describe('getNextPhase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('transitions hook -> qualify when interest > 0.3', () => {
    const session = createMockSession({ phase: 'hook' });
    const result = getNextPhase(
      session,
      { interest_score: 0.35, reply_text: 'Zanimljivo.' },
      'Recite mi vise o tome.',
    );
    expect(result).toBe('qualify');
  });

  it('stays in hook when interest <= 0.3', () => {
    const session = createMockSession({ phase: 'hook' });
    const result = getNextPhase(
      session,
      { interest_score: 0.2, reply_text: 'Hmm.' },
      'Hmm.',
    );
    expect(result).toBe('hook');
  });

  it('transitions qualify -> pitch when interest > 0.5', () => {
    const session = createMockSession({ phase: 'qualify' });
    const result = getNextPhase(
      session,
      { interest_score: 0.55, reply_text: 'To zvuci dobro.' },
      'Mozda, recite mi vise.',
    );
    expect(result).toBe('pitch');
  });

  it('stays in qualify when interest <= 0.5', () => {
    const session = createMockSession({ phase: 'qualify' });
    const result = getNextPhase(
      session,
      { interest_score: 0.4, reply_text: 'Ok.' },
      'Ok.',
    );
    expect(result).toBe('qualify');
  });

  it('transitions pitch -> objection when objection detected in user transcript', () => {
    const session = createMockSession({ phase: 'pitch' });
    const result = getNextPhase(
      session,
      { interest_score: 0.6, reply_text: 'Razumijemo vas.' },
      'Ne zanima me to uopste.',
    );
    expect(result).toBe('objection');
  });

  it('transitions pitch -> close when interest > 0.72 and no objection in user transcript', () => {
    const session = createMockSession({ phase: 'pitch' });
    const result = getNextPhase(
      session,
      { interest_score: 0.8, reply_text: 'Odlicna ponuda.' },
      'Zanimljivo, recite mi jos.',
    );
    expect(result).toBe('close');
  });

  it('prioritizes objection over close in pitch phase when user says skupo', () => {
    const session = createMockSession({ phase: 'pitch' });
    const result = getNextPhase(
      session,
      { interest_score: 0.9, reply_text: 'Razumijemo.' },
      'Ne mogu to priustiti, preskupo je.',
    );
    expect(result).toBe('objection');
  });

  it('stays in pitch when interest <= 0.72 and no objection in user transcript', () => {
    const session = createMockSession({ phase: 'pitch' });
    const result = getNextPhase(
      session,
      { interest_score: 0.6, reply_text: 'Hmm, zanimljivo.' },
      'Mozda, vidjecemo.',
    );
    expect(result).toBe('pitch');
  });

  it('transitions objection -> close when interest > 0.72', () => {
    const session = createMockSession({ phase: 'objection' });
    const result = getNextPhase(
      session,
      { interest_score: 0.8, reply_text: 'To ima smisla.' },
      'Zapravo, to ima smisla.',
    );
    expect(result).toBe('close');
  });

  it('transitions objection -> pitch when interest <= 0.72', () => {
    const session = createMockSession({ phase: 'objection' });
    const result = getNextPhase(
      session,
      { interest_score: 0.5, reply_text: 'Hmm, mozda.' },
      'Mozda, ne znam.',
    );
    expect(result).toBe('pitch');
  });

  it('transitions close -> confirm when agreement detected in user transcript', () => {
    const session = createMockSession({ phase: 'close' });
    const result = getNextPhase(
      session,
      { interest_score: 0.9, reply_text: 'Izvrsno!' },
      'Da, prihvatam ponudu.',
    );
    expect(result).toBe('confirm');
  });

  it('transitions close -> objection when objection detected in user transcript', () => {
    const session = createMockSession({ phase: 'close' });
    const result = getNextPhase(
      session,
      { interest_score: 0.4, reply_text: 'Razumijemo.' },
      'Ne mogu to sebi priustiti, skupo je.',
    );
    expect(result).toBe('objection');
  });

  it('stays in close when neither agreement nor objection in user transcript', () => {
    const session = createMockSession({ phase: 'close' });
    const result = getNextPhase(
      session,
      { interest_score: 0.6, reply_text: 'Razmislite o tome.' },
      'Razmislit cu o tome.',
    );
    expect(result).toBe('close');
  });

  it('stays in confirm (terminal phase)', () => {
    const session = createMockSession({ phase: 'confirm' });
    const result = getNextPhase(
      session,
      { interest_score: 0.1, reply_text: 'Hvala.' },
      'Ne zanima me vise.',
    );
    expect(result).toBe('confirm');
  });

  it('does not trigger objection phase when objection is in bot reply but not user transcript', () => {
    const session = createMockSession({ phase: 'pitch' });
    // Bot mentions "ne zanima" in reply but user said something neutral
    const result = getNextPhase(
      session,
      { interest_score: 0.6, reply_text: 'Razumijemo da ne zanima, ali...' },
      'Hmm, nisam siguran.',
    );
    // Should stay in pitch — interest 0.6, no objection in user text
    expect(result).toBe('pitch');
  });

  it('does not trigger agreement phase when agreement word is in bot reply but not user transcript', () => {
    const session = createMockSession({ phase: 'close' });
    // Bot says "prihvatam" in reply but user said something else
    const result = getNextPhase(
      session,
      { interest_score: 0.5, reply_text: 'Prihvatam vase pitanje.' },
      'Nisam siguran jos.',
    );
    // Should stay in close
    expect(result).toBe('close');
  });
});

describe('checkCallDuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false for a fresh call', () => {
    const session = createMockSession({ startedAt: new Date() });
    expect(checkCallDuration(session)).toBe(false);
  });

  it('returns false for a call under 9 minutes', () => {
    const eightMinutesAgo = new Date(Date.now() - 8 * 60 * 1000);
    const session = createMockSession({ startedAt: eightMinutesAgo });
    expect(checkCallDuration(session)).toBe(false);
  });

  it('returns true for a call over 9 minutes', () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const session = createMockSession({ startedAt: tenMinutesAgo });
    expect(checkCallDuration(session)).toBe(true);
  });

  it('returns true at exactly 9 minutes and 1 ms', () => {
    const nineMinutesPlusOneMs = new Date(Date.now() - MAX_CALL_DURATION_MS - 1);
    const session = createMockSession({ startedAt: nineMinutesPlusOneMs });
    expect(checkCallDuration(session)).toBe(true);
  });
});

describe('hasObjection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects "ne zanima" as an objection', () => {
    expect(hasObjection('Ne zanima me to')).toBe(true);
  });

  it('detects "skupo" as an objection', () => {
    expect(hasObjection('To je previse skupo')).toBe(true);
  });

  it('detects "ne mogu" as an objection', () => {
    expect(hasObjection('Ne mogu to sebi priustiti')).toBe(true);
  });

  it('detects "nemam vremena" as an objection', () => {
    expect(hasObjection('Nemam vremena za to')).toBe(true);
  });

  it('detects "ne treba" as an objection', () => {
    expect(hasObjection('Meni ne treba to')).toBe(true);
  });

  it('detects objections case-insensitively', () => {
    expect(hasObjection('NE ZANIMA ME TO')).toBe(true);
    expect(hasObjection('SKUPO')).toBe(true);
  });

  it('returns false for neutral text', () => {
    expect(hasObjection('Recite mi vise o tome')).toBe(false);
  });

  it('returns false for empty text', () => {
    expect(hasObjection('')).toBe(false);
  });

  it('does not detect "ali" as an objection (too generic)', () => {
    expect(hasObjection('Ali ja to ne razumijem')).toBe(false);
  });

  it('does not detect standalone "problem" as an objection (too generic)', () => {
    expect(hasObjection('Imam problem sa tim')).toBe(false);
  });

  it('detects "preskupo" as an objection', () => {
    expect(hasObjection('To je preskupo za mene')).toBe(true);
  });

  it('detects "nisam zainteresovan" as an objection', () => {
    expect(hasObjection('Nisam zainteresovan za to')).toBe(true);
  });
});

describe('hasAgreement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects "prihvatam" as agreement', () => {
    expect(hasAgreement('Da, prihvatam')).toBe(true);
  });

  it('detects "dogovoreno" as agreement', () => {
    expect(hasAgreement('Dogovoreno, hajde')).toBe(true);
  });

  it('detects "slazem se" as agreement', () => {
    expect(hasAgreement('Slazem se sa tim')).toBe(true);
  });

  it('does not detect standalone "moze" as agreement (too generic)', () => {
    expect(hasAgreement('Moze, u redu')).toBe(false);
  });

  it('detects "da, moze" as agreement', () => {
    expect(hasAgreement('Da, moze')).toBe(true);
  });

  it('detects agreement case-insensitively', () => {
    expect(hasAgreement('PRIHVATAM')).toBe(true);
    expect(hasAgreement('DOGOVORENO')).toBe(true);
  });

  it('returns false for objection text', () => {
    expect(hasAgreement('Ne zanima me to')).toBe(false);
  });

  it('returns false for empty text', () => {
    expect(hasAgreement('')).toBe(false);
  });

  it('does not detect "odlicno" as agreement (bot uses it constantly)', () => {
    expect(hasAgreement('Odlicno, to mi odgovara')).toBe(false);
  });

  it('detects "zelim da se prijavim" as agreement', () => {
    expect(hasAgreement('Zelim da se prijavim')).toBe(true);
  });

  it('detects "potpisi" as agreement', () => {
    expect(hasAgreement('Da, potpisi me')).toBe(true);
  });

  it('detects "pristajem" as agreement', () => {
    expect(hasAgreement('Pristajem na uvjete')).toBe(true);
  });
});
