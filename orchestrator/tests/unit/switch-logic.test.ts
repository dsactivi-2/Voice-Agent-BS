import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shouldSwitchToFull, assignABGroup } from '../../src/llm/switch-logic.js';
import type { CallSession } from '../../src/types.js';

vi.mock('../../src/config.js', () => ({
  config: {
    LLM_SWITCH_INTEREST_THRESHOLD: 0.72,
    LLM_SWITCH_COMPLEXITY_THRESHOLD: 0.60,
  },
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function createMockSession(overrides: Partial<CallSession> = {}): CallSession {
  return {
    callId: 'test-call-1',
    phoneNumber: '+38761000000',
    language: 'bs-BA',
    llmMode: 'mini',
    interestScores: [0.5, 0.5, 0.5],
    complexityScore: 0.3,
    phase: 'hook',
    campaignId: 'campaign-1',
    abGroup: 'mini_to_full',
    startedAt: new Date(),
    turnCount: 3,
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

describe('shouldSwitchToFull', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when already in full mode', () => {
    const session = createMockSession({ llmMode: 'full' });
    expect(shouldSwitchToFull(session)).toBe(false);
  });

  it('returns false for mini_only A/B group', () => {
    const session = createMockSession({
      abGroup: 'mini_only',
      phase: 'pitch',
      interestScores: [0.9, 0.9, 0.9],
    });
    expect(shouldSwitchToFull(session)).toBe(false);
  });

  it('returns true for full_only A/B group', () => {
    const session = createMockSession({ abGroup: 'full_only' });
    expect(shouldSwitchToFull(session)).toBe(true);
  });

  it('returns false when phase is not pitch, objection, or close', () => {
    const session = createMockSession({
      phase: 'hook',
      interestScores: [0.9, 0.9, 0.9],
      complexityScore: 0.9,
    });
    expect(shouldSwitchToFull(session)).toBe(false);
  });

  it('returns true when both scores exceed thresholds in objection phase', () => {
    const session = createMockSession({
      phase: 'objection',
      interestScores: [0.8, 0.85, 0.9], // avg 0.85 > 0.72
      complexityScore: 0.65,             // > 0.60
    });
    expect(shouldSwitchToFull(session)).toBe(true);
  });

  it('returns true when both scores exceed thresholds in close phase', () => {
    const session = createMockSession({
      phase: 'close',
      complexityScore: 0.75,            // > 0.60
      interestScores: [0.8, 0.8, 0.8], // avg 0.8 > 0.72
    });
    expect(shouldSwitchToFull(session)).toBe(true);
  });

  it('returns false when scores are below thresholds', () => {
    const session = createMockSession({
      phase: 'pitch',
      interestScores: [0.5, 0.5, 0.5],
      complexityScore: 0.3,
    });
    expect(shouldSwitchToFull(session)).toBe(false);
  });

  it('uses only last 3 interest scores for average calculation', () => {
    // First 2 scores (0.1) are ignored; last 3 avg = 0.85 > 0.72
    const session = createMockSession({
      phase: 'objection',
      interestScores: [0.1, 0.1, 0.8, 0.85, 0.9],
      complexityScore: 0.65, // > 0.60 — both thresholds must be met
    });
    expect(shouldSwitchToFull(session)).toBe(true);
  });

  it('returns true in objection phase when both thresholds are exceeded', () => {
    const session = createMockSession({
      phase: 'objection',
      complexityScore: 0.65,            // > 0.60
      interestScores: [0.8, 0.8, 0.8], // avg 0.8 > 0.72
    });
    expect(shouldSwitchToFull(session)).toBe(true);
  });
});

describe('assignABGroup', () => {
  it('returns a valid AB group', () => {
    const group = assignABGroup('+38761000000', 'campaign-1');
    expect(['mini_only', 'mini_to_full', 'full_only']).toContain(group);
  });

  it('is deterministic — same input always returns same output', () => {
    const group1 = assignABGroup('+38761000000', 'campaign-1');
    const group2 = assignABGroup('+38761000000', 'campaign-1');
    const group3 = assignABGroup('+38761000000', 'campaign-1');
    expect(group1).toBe(group2);
    expect(group2).toBe(group3);
  });

  it('different phone numbers can produce different groups', () => {
    const groups = new Set<string>();
    for (let i = 0; i < 100; i++) {
      groups.add(assignABGroup(`+3876100${String(i).padStart(4, '0')}`, 'campaign-1'));
    }
    // With 100 different phone numbers, we should see more than 1 group
    expect(groups.size).toBeGreaterThan(1);
  });

  it('different campaigns can produce different groups for same phone', () => {
    const groups = new Set<string>();
    for (let i = 0; i < 100; i++) {
      groups.add(assignABGroup('+38761000000', `campaign-${i}`));
    }
    expect(groups.size).toBeGreaterThan(1);
  });
});
