import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallSession } from '../../src/types.js';

const { mockCreate } = vi.hoisted(() => {
  return { mockCreate: vi.fn() };
});

vi.mock('../../src/config.js', () => ({
  config: {
    OPENAI_API_KEY: 'test-key',
    LLM_MINI_MODEL: 'gpt-4o-mini',
    LLM_FULL_MODEL: 'gpt-4o',
    LLM_TIMEOUT_MS: 5000,
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

import {
  streamLLMResponse,
  getLLMResponseWithFallback,
} from '../../src/llm/client.js';

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

function createMockStream(chunks: string[]) {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (index < chunks.length) {
            const value = {
              choices: [{ delta: { content: chunks[index] } }],
            };
            index++;
            return Promise.resolve({ value, done: false as const });
          }
          return Promise.resolve({ value: undefined, done: true as const });
        },
      };
    },
  };
}

describe('streamLLMResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('yields individual tokens from the stream', async () => {
    const jsonParts = [
      '{"reply_text":',
      '"Zdravo"',
      ',"interest_score":0.5',
      ',"complexity_score":0.3',
      ',"phase":"hook"}',
    ];
    mockCreate.mockResolvedValue(createMockStream(jsonParts));

    const generator = streamLLMResponse({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Hello' }],
      maxTokens: 300,
    });

    const tokens: string[] = [];
    let result = await generator.next();
    while (!result.done) {
      tokens.push(result.value);
      result = await generator.next();
    }

    expect(tokens).toEqual(jsonParts);
    expect(result.value).toEqual({
      reply_text: 'Zdravo',
      interest_score: 0.5,
      complexity_score: 0.3,
      phase: 'hook',
    });
  });

  it('returns complete parsed LLMResponse at the end', async () => {
    const fullJson =
      '{"reply_text":"Dobro jutro","interest_score":0.7,"complexity_score":0.4,"phase":"qualify"}';
    mockCreate.mockResolvedValue(createMockStream([fullJson]));

    const generator = streamLLMResponse({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Test' }],
      maxTokens: 300,
    });

    let result = await generator.next();
    while (!result.done) {
      result = await generator.next();
    }

    expect(result.value).toEqual({
      reply_text: 'Dobro jutro',
      interest_score: 0.7,
      complexity_score: 0.4,
      phase: 'qualify',
    });
  });

  it('throws on invalid JSON from LLM', async () => {
    mockCreate.mockResolvedValue(createMockStream(['not valid json {{{']));

    const consumeGenerator = async () => {
      const generator = streamLLMResponse({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Test' }],
        maxTokens: 300,
      });

      let result = await generator.next();
      while (!result.done) {
        result = await generator.next();
      }
    };

    await expect(consumeGenerator()).rejects.toThrow();
  });
});

describe('getLLMResponseWithFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns parsed LLM response on success', async () => {
    const responseJson =
      '{"reply_text":"Zdravo, ja sam Goran.","interest_score":0.6,"complexity_score":0.3,"phase":"hook"}';
    mockCreate.mockResolvedValue(createMockStream([responseJson]));

    const session = createMockSession();
    const result = await getLLMResponseWithFallback(session, 'Halo?', {
      systemPrompt: 'Test prompt',
      messages: [{ role: 'system', content: 'Test prompt' }],
    });

    expect(result).toEqual({
      reply_text: 'Zdravo, ja sam Goran.',
      interest_score: 0.6,
      complexity_score: 0.3,
      phase: 'hook',
    });
  });

  it('returns BS fallback response on timeout/error', async () => {
    mockCreate.mockRejectedValue(new Error('API Error'));

    const session = createMockSession({ language: 'bs-BA' });
    const result = await getLLMResponseWithFallback(session, 'Halo?', {
      systemPrompt: 'Test prompt',
      messages: [{ role: 'system', content: 'Test prompt' }],
    });

    expect(result.reply_text).toBe('Mozete li ponoviti, molim vas?');
    expect(result.interest_score).toBe(0.5);
  });

  it('returns SR fallback response on timeout/error', async () => {
    mockCreate.mockRejectedValue(new Error('Timeout'));

    const session = createMockSession({ language: 'sr-RS' });
    const result = await getLLMResponseWithFallback(session, 'Halo?', {
      systemPrompt: 'Test prompt',
      messages: [{ role: 'system', content: 'Test prompt' }],
    });

    expect(result.reply_text).toBe('Mozete li da ponovite, molim vas?');
    expect(result.interest_score).toBe(0.5);
  });

  it('returns fallback on invalid JSON from LLM', async () => {
    mockCreate.mockResolvedValue(
      createMockStream(['this is not json at all']),
    );

    const session = createMockSession({ language: 'bs-BA' });
    const result = await getLLMResponseWithFallback(session, 'Halo?', {
      systemPrompt: 'Test prompt',
      messages: [{ role: 'system', content: 'Test prompt' }],
    });

    expect(result.reply_text).toBe('Mozete li ponoviti, molim vas?');
  });

  it('uses full model when session llmMode is full', async () => {
    const responseJson =
      '{"reply_text":"Test","interest_score":0.5,"complexity_score":0.3,"phase":"hook"}';
    mockCreate.mockResolvedValue(createMockStream([responseJson]));

    const session = createMockSession({ llmMode: 'full' });
    await getLLMResponseWithFallback(session, 'Test', {
      systemPrompt: 'Test',
      messages: [{ role: 'system', content: 'Test' }],
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o' }),
    );
  });
});
