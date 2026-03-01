import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Turn, LLMResponse } from '../../src/types.js';

const { mockCreate } = vi.hoisted(() => {
  return { mockCreate: vi.fn() };
});

vi.mock('../../src/config.js', () => ({
  config: {
    OPENAI_API_KEY: 'test-key',
    LLM_MINI_MODEL: 'gpt-4o-mini',
    MEMORY_ACTIVE_WINDOW_TURNS: 4,
    MEMORY_SUMMARY_INTERVAL_TURNS: 5,
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

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mockCreate,
        },
      };
    },
  };
});

import { MemoryManager } from '../../src/llm/memory-manager.js';

function createTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    callId: 'test-call-1',
    turnNumber: 1,
    speaker: 'user',
    text: 'Hello',
    llmMode: 'mini',
    timestamp: new Date(),
    ...overrides,
  };
}

describe('MemoryManager', () => {
  let manager: MemoryManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MemoryManager();
  });

  it('stores turns via addTurn', () => {
    manager.addTurn(createTurn({ text: 'Turn 1' }));
    manager.addTurn(createTurn({ text: 'Turn 2', speaker: 'bot' }));

    const context = manager.buildLLMContext('System prompt');
    // system + 2 turns
    expect(context).toHaveLength(3);
    expect(context[1]!.content).toBe('Turn 1');
    expect(context[2]!.content).toBe('Turn 2');
  });

  it('buildLLMContext returns system prompt as first message', () => {
    const context = manager.buildLLMContext('You are a sales agent.');
    expect(context[0]).toEqual({
      role: 'system',
      content: 'You are a sales agent.',
    });
  });

  it('active window only contains last N turns', () => {
    // Set up mock for summary generation that triggers at turn 5
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Test summary' } }],
    });

    for (let i = 1; i <= 6; i++) {
      manager.addTurn(
        createTurn({
          text: `Turn ${i}`,
          turnNumber: i,
          speaker: i % 2 === 0 ? 'bot' : 'user',
        }),
      );
    }

    const context = manager.buildLLMContext('System');
    // system + last 4 turns (3, 4, 5, 6)
    const turnMessages = context.filter((m) => m.role !== 'system');
    expect(turnMessages).toHaveLength(4);
    expect(turnMessages[0]!.content).toBe('Turn 3');
    expect(turnMessages[3]!.content).toBe('Turn 6');
  });

  it('triggers summary generation after MEMORY_SUMMARY_INTERVAL_TURNS turns', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Summary of the conversation.' } }],
    });

    for (let i = 1; i <= 5; i++) {
      manager.addTurn(createTurn({ text: `Turn ${i}`, turnNumber: i }));
    }

    // Wait for the async summary to complete
    await vi.waitFor(() => {
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    // Verify the summary was stored
    expect(manager.getSummary()).toBe('Summary of the conversation.');
  });

  it('includes summary in LLM context when available (in BS/SR language)', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        { message: { content: 'Korisnik je zainteresiran za posao u Njemačkoj.' } },
      ],
    });

    for (let i = 1; i <= 5; i++) {
      manager.addTurn(createTurn({ text: `Turn ${i}`, turnNumber: i }));
    }

    await vi.waitFor(() => {
      expect(manager.getSummary()).toBeTruthy();
    });

    const context = manager.buildLLMContext('System');
    const summaryMessage = context.find((m) =>
      m.content.startsWith('Dosadašnji razgovor:'),
    );
    expect(summaryMessage).toBeDefined();
    expect(summaryMessage!.content).toContain(
      'Korisnik je zainteresiran za posao u Njemačkoj.',
    );
  });

  it('updates structured memory from LLM response based on user transcript', () => {
    const response: LLMResponse = {
      reply_text: 'Razumijemo, imamo besplatnu obuku za sve.',
      interest_score: 0.8,
      complexity_score: 0.6,
      phase: 'objection',
    };
    // Objection keyword "ne znam jezik" is in the user's words, not the bot's reply
    const userTranscript = 'Kazem da ne znam jezik, ne mogu raditi.';

    manager.updateFromLLMResponse(response, userTranscript);

    const memory = manager.getStructuredMemory();
    expect(memory.tone).toBe('skeptical');
    expect(memory.microCommitment).toBe(true);
    expect(memory.objections).toContain('ne znam jezik');
  });

  it('does not record objection when objection is only in bot reply (not user transcript)', () => {
    const response: LLMResponse = {
      reply_text: 'Kazete da ne znam jezik, ali imamo obuku.',
      interest_score: 0.8,
      complexity_score: 0.6,
      phase: 'objection',
    };
    // User said something neutral — objection is only in bot's reply paraphrase
    const userTranscript = 'Hmm, nisam siguran.';

    manager.updateFromLLMResponse(response, userTranscript);

    const memory = manager.getStructuredMemory();
    // "ne znam jezik" was only in bot reply, not user transcript — should NOT be recorded
    expect(memory.objections).not.toContain('ne znam jezik');
  });

  it('does not duplicate objections', () => {
    const response: LLMResponse = {
      reply_text: 'Razumijemo.',
      interest_score: 0.3,
      complexity_score: 0.7,
      phase: 'objection',
    };
    const userTranscript = 'Ne mogu to prihvatiti jer ne mogu platiti.';

    manager.updateFromLLMResponse(response, userTranscript);
    manager.updateFromLLMResponse(response, userTranscript);

    const memory = manager.getStructuredMemory();
    const neMotgu = memory.objections.filter((o) => o === 'ne mogu');
    expect(neMotgu).toHaveLength(1);
  });

  it('reset clears all state', () => {
    manager.addTurn(createTurn({ text: 'Some turn' }));
    manager.updateFromLLMResponse(
      {
        reply_text: 'Response',
        interest_score: 0.9,
        complexity_score: 0.7,
        phase: 'pitch',
      },
      '',
    );

    manager.reset();

    expect(manager.getSummary()).toBe('');
    expect(manager.getStructuredMemory()).toEqual({
      objections: [],
      tone: 'neutral',
      microCommitment: false,
    });
    const context = manager.buildLLMContext('System');
    expect(context).toHaveLength(1); // Only system prompt
  });

  it('includes structured memory in context when objection data is present', () => {
    // Objection keyword in user transcript, not bot reply
    manager.updateFromLLMResponse(
      {
        reply_text: 'Razumijemo, imamo rjesenje za to.',
        interest_score: 0.8,
        complexity_score: 0.4,
        phase: 'qualify',
      },
      'Nemam iskustvo u toj oblasti.',
    );

    const context = manager.buildLLMContext('System');
    const infoMsg = context.find((m) =>
      m.content.startsWith('Info o korisniku:'),
    );
    expect(infoMsg).toBeDefined();
    expect(infoMsg!.content).toContain('nemam iskustvo');
  });

  describe('H6: cross-call memory', () => {
    it('loadCrossCallMemory injects summary into buildLLMContext', () => {
      manager.loadCrossCallMemory({
        summary: 'Korisnik je zainteresiran za rad u Njemackoj, ali ima brige oko jezika.',
        structured: null,
        callCount: 2,
      });

      const context = manager.buildLLMContext('System');
      const crossCallMsg = context.find((m) =>
        m.content.startsWith('Prethodni razgovor'),
      );

      expect(crossCallMsg).toBeDefined();
      expect(crossCallMsg!.content).toContain('2. poziv');
      expect(crossCallMsg!.content).toContain('Korisnik je zainteresiran');
    });

    it('cross-call message appears after system prompt but before current summary', () => {
      manager.loadCrossCallMemory({
        summary: 'Prior call context.',
        structured: null,
        callCount: 1,
      });

      // Trigger an in-call summary
      mockCreate.mockResolvedValue({ choices: [{ message: { content: 'Current summary.' } }] });

      const context = manager.buildLLMContext('System');

      const systemIdx = context.findIndex((m) => m.content === 'System');
      const crossCallIdx = context.findIndex((m) => m.content.startsWith('Prethodni razgovor'));

      // cross-call must come immediately after system prompt (index 1)
      expect(systemIdx).toBe(0);
      expect(crossCallIdx).toBe(1);
    });

    it('loadCrossCallMemory merges objections from prior call', () => {
      manager.loadCrossCallMemory({
        summary: null,
        structured: {
          objections: ['ne znam jezik', 'ne mogu'],
          tone: 'skeptical',
          microCommitment: false,
        },
        callCount: 1,
      });

      const memory = manager.getStructuredMemory();
      expect(memory.objections).toContain('ne znam jezik');
      expect(memory.objections).toContain('ne mogu');
    });

    it('does not add duplicate objections if same objection raised again in current call', () => {
      manager.loadCrossCallMemory({
        summary: null,
        structured: {
          objections: ['ne mogu'],
          tone: 'neutral',
          microCommitment: false,
        },
        callCount: 1,
      });

      manager.updateFromLLMResponse(
        { reply_text: 'Razumijemo.', interest_score: 0.3, complexity_score: 0.5, phase: 'objection' },
        'Ne mogu to prihvatiti.',
      );

      const memory = manager.getStructuredMemory();
      const neMogu = memory.objections.filter((o) => o === 'ne mogu');
      expect(neMogu).toHaveLength(1);
    });

    it('does not inject cross-call message when no prior summary exists', () => {
      // loadCrossCallMemory with null summary
      manager.loadCrossCallMemory({ summary: null, structured: null, callCount: 0 });

      const context = manager.buildLLMContext('System');
      const crossCallMsg = context.find((m) => m.content.startsWith('Prethodni razgovor'));

      expect(crossCallMsg).toBeUndefined();
    });

    it('reset clears cross-call memory', () => {
      manager.loadCrossCallMemory({
        summary: 'Some prior context.',
        structured: { objections: ['ne mogu'], tone: 'skeptical', microCommitment: true },
        callCount: 3,
      });

      manager.reset();

      const context = manager.buildLLMContext('System');
      const crossCallMsg = context.find((m) => m.content.startsWith('Prethodni razgovor'));
      expect(crossCallMsg).toBeUndefined();

      const memory = manager.getStructuredMemory();
      expect(memory.objections).toHaveLength(0);
      expect(memory.tone).toBe('neutral');
    });
  });
});
