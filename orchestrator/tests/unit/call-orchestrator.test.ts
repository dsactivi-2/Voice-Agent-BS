import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentConfig, LLMResponse } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Hoisted mock functions — available inside vi.mock factories
// ---------------------------------------------------------------------------

const {
  mockCreateCall,
  mockUpdateCallResult,
  mockInsertTurn,
  mockInsertMetric,
  mockUpsertCallMemory,
  mockAssignABGroup,
  mockStreamLLMResponse,
  mockGetCachedAudio,
  mockSelectFiller,
  mockGetFillerPhrase,
  mockCalculateAdaptiveDelay,
  mockShouldSwitchToFull,
  mockCreateCallSession,
  mockGetNextPhase,
  mockCheckCallDuration,
} = vi.hoisted(() => ({
  mockCreateCall: vi.fn().mockResolvedValue(undefined),
  mockUpdateCallResult: vi.fn().mockResolvedValue(undefined),
  mockInsertTurn: vi.fn().mockResolvedValue(undefined),
  mockInsertMetric: vi.fn().mockResolvedValue(undefined),
  mockUpsertCallMemory: vi.fn().mockResolvedValue(undefined),
  mockAssignABGroup: vi.fn().mockReturnValue('mini_to_full'),
  mockStreamLLMResponse: vi.fn(),
  mockGetCachedAudio: vi.fn().mockResolvedValue(Buffer.from('fake-audio')),
  mockSelectFiller: vi.fn().mockReturnValue(null),
  mockGetFillerPhrase: vi.fn().mockReturnValue('Razumijem.'),
  mockCalculateAdaptiveDelay: vi.fn().mockReturnValue(0),
  mockShouldSwitchToFull: vi.fn().mockReturnValue(false),
  mockCreateCallSession: vi.fn().mockImplementation((params: Record<string, unknown>) => ({
    callId: params['callId'],
    phoneNumber: params['phoneNumber'],
    language: params['language'],
    llmMode: params['initialLLMMode'] || 'mini',
    interestScores: [],
    complexityScore: 0,
    phase: 'hook' as const,
    campaignId: params['campaignId'],
    abGroup: params['abGroup'],
    startedAt: new Date(),
    turnCount: 0,
    conversationSummary: '',
    structuredMemory: {
      objections: [],
      tone: 'neutral' as const,
      microCommitment: false,
    },
    callerSpokeRecently: false,
  })),
  mockGetNextPhase: vi.fn().mockReturnValue('hook'),
  mockCheckCallDuration: vi.fn().mockReturnValue(false),
}));

// ---------------------------------------------------------------------------
// Mock all dependencies
// ---------------------------------------------------------------------------

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    RING_BUFFER_SIZE_KB: 32,
    VAD_ENDPOINTING_MS: 300,
    VAD_GRACE_MS: 200,
    VAD_BARGE_IN_MIN_MS: 150,
    VAD_SILENCE_TIMEOUT_MS: 10000,
    SILENCE_PRESSURE_AFTER_OFFER_MS: 2500,
    LLM_MINI_MODEL: 'gpt-4o-mini',
    LLM_FULL_MODEL: 'gpt-4o',
    LLM_TIMEOUT_MS: 5000,
    LLM_SWITCH_INTEREST_THRESHOLD: 0.72,
    LLM_SWITCH_COMPLEXITY_THRESHOLD: 0.60,
    MEMORY_SUMMARY_INTERVAL_TURNS: 5,
    MEMORY_ACTIVE_WINDOW_TURNS: 4,
    MEMORY_CROSS_CALL_ENABLED: true,
    ADAPTIVE_DELAY_MIN_MS: 200,
    ADAPTIVE_DELAY_MAX_MS: 800,
    TTS_CACHE_TTL_SECONDS: 86400,
  },
}));

vi.mock('../../src/db/queries.js', () => ({
  createCall: (...args: unknown[]) => mockCreateCall(...args),
  updateCallResult: (...args: unknown[]) => mockUpdateCallResult(...args),
  insertTurn: (...args: unknown[]) => mockInsertTurn(...args),
  insertMetric: (...args: unknown[]) => mockInsertMetric(...args),
  upsertCallMemory: (...args: unknown[]) => mockUpsertCallMemory(...args),
}));

vi.mock('../../src/llm/switch-logic.js', () => ({
  shouldSwitchToFull: (...args: unknown[]) => mockShouldSwitchToFull(...args),
  assignABGroup: (...args: unknown[]) => mockAssignABGroup(...args),
}));

vi.mock('../../src/llm/client.js', () => ({
  streamLLMResponse: (...args: unknown[]) => mockStreamLLMResponse(...args),
}));

vi.mock('../../src/llm/memory-manager.js', async () => {
  const MemoryManager = vi.fn();
  MemoryManager.prototype.addTurn = vi.fn();
  MemoryManager.prototype.getSummary = vi.fn().mockReturnValue('Test summary');
  MemoryManager.prototype.getStructuredMemory = vi.fn().mockReturnValue({
    objections: [],
    tone: 'neutral',
    microCommitment: false,
  });
  MemoryManager.prototype.buildLLMContext = vi.fn().mockReturnValue([
    { role: 'system', content: 'Test prompt' },
  ]);
  MemoryManager.prototype.updateFromLLMResponse = vi.fn();
  MemoryManager.prototype.reset = vi.fn();
  return { MemoryManager };
});

vi.mock('../../src/vad/detector.js', async () => {
  const { EventEmitter } = await import('node:events');
  class MockVADDetector extends EventEmitter {
    processAudio = vi.fn();
    destroy = vi.fn();
    reset = vi.fn();
    getState = vi.fn().mockReturnValue('idle');
  }
  return { VADDetector: MockVADDetector };
});

vi.mock('../../src/vad/turn-taking.js', async () => {
  const { EventEmitter } = await import('node:events');
  class MockTurnTakingManager extends EventEmitter {
    setBotSpeaking = vi.fn();
    setPhase = vi.fn();
    onTranscriptReceived = vi.fn();
    destroy = vi.fn();
    reset = vi.fn();
  }
  return { TurnTakingManager: MockTurnTakingManager };
});

vi.mock('../../src/tts/chunked-stream.js', async () => {
  const { EventEmitter } = await import('node:events');
  class MockChunkedTTSPipeline extends EventEmitter {
    addTokens = vi.fn();
    flush = vi.fn().mockResolvedValue(undefined);
    destroy = vi.fn();
  }
  return { ChunkedTTSPipeline: MockChunkedTTSPipeline };
});

vi.mock('../../src/tts/cache.js', () => ({
  getCachedAudio: (...args: unknown[]) => mockGetCachedAudio(...args),
}));

vi.mock('../../src/filler.js', () => ({
  selectFiller: (...args: unknown[]) => mockSelectFiller(...args),
  getFillerPhrase: (...args: unknown[]) => mockGetFillerPhrase(...args),
}));

vi.mock('../../src/session/adaptive-delay.js', () => ({
  calculateAdaptiveDelay: (...args: unknown[]) => mockCalculateAdaptiveDelay(...args),
}));

vi.mock('../../src/session/call-session.js', () => ({
  createCallSession: (...args: unknown[]) => mockCreateCallSession(...args),
  getNextPhase: (...args: unknown[]) => mockGetNextPhase(...args),
  checkCallDuration: (...args: unknown[]) => mockCheckCallDuration(...args),
}));

vi.mock('../../src/audio/ring-buffer.js', () => {
  class MockRingBuffer {
    write = vi.fn();
    read = vi.fn().mockReturnValue(null);
    clear = vi.fn();
  }
  return { RingBuffer: MockRingBuffer };
});

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { CallOrchestrator } from '../../src/call-orchestrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockMediaSession() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    sendAudio: vi.fn(),
    close: vi.fn(),
    isOpen: vi.fn().mockReturnValue(true),
    getStreamId: vi.fn().mockReturnValue('stream-1'),
    getCallControlId: vi.fn().mockReturnValue('ctrl-1'),
  });
}

function createMockAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    language: 'bs-BA',
    telnyxPhoneNumber: '+38761000001',
    deepgramLanguage: 'bs',
    ttsVoice: 'bs-BA-GoranNeural',
    systemPrompt: 'You are a helpful sales agent.',
    fillerLibrary: {
      acknowledge: ['Razumijem.', 'Da, da.'],
      thinking: ['Hajde da vidimo...'],
      affirm: ['Odlicno!'],
    },
    cachedPhrases: {},
    ...overrides,
  };
}

function createOrchestrator(mediaSession?: ReturnType<typeof createMockMediaSession>) {
  const session = mediaSession ?? createMockMediaSession();
  const orchestrator = new CallOrchestrator({
    callId: 'test-call-123',
    phoneNumber: '+38761000000',
    agentConfig: createMockAgentConfig(),
    campaignId: 'campaign-1',
    mediaSession: session as unknown as import('../../src/telnyx/media-stream.js').MediaStreamSession,
  });
  return { orchestrator, mediaSession: session };
}

/** Creates a mock async generator that yields tokens then returns a parsed LLMResponse. */
function createMockLLMGenerator(tokens: string[], response: LLMResponse) {
  async function* generator(): AsyncGenerator<string, LLMResponse> {
    for (const token of tokens) {
      yield token;
    }
    return response;
  }
  return generator();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CallOrchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('start()', () => {
    it('initializes all components and creates DB call record', async () => {
      const { orchestrator } = createOrchestrator();
      const startedHandler = vi.fn();
      orchestrator.on('started', startedHandler);

      await orchestrator.start();

      expect(mockCreateCall).toHaveBeenCalledWith(
        expect.objectContaining({
          callId: 'test-call-123',
          phoneNumber: '+38761000000',
          language: 'bs-BA',
          campaignId: 'campaign-1',
        }),
      );

      expect(startedHandler).toHaveBeenCalledWith('test-call-123');
    });

    it('assigns AB group from phone number and campaign', async () => {
      const { orchestrator } = createOrchestrator();

      await orchestrator.start();

      expect(mockAssignABGroup).toHaveBeenCalledWith('+38761000000', 'campaign-1');
    });

    it('continues when DB create call fails (safeDbOperation)', async () => {
      mockCreateCall.mockRejectedValueOnce(new Error('DB connection failed'));

      const { orchestrator } = createOrchestrator();
      const startedHandler = vi.fn();
      orchestrator.on('started', startedHandler);

      await orchestrator.start();

      expect(mockCreateCall).toHaveBeenCalled();
      expect(startedHandler).toHaveBeenCalledWith('test-call-123');
    });
  });

  describe('handleUserFinishedSpeaking', () => {
    it('triggers LLM + TTS pipeline on user transcript', async () => {
      const mockResponse: LLMResponse = {
        reply_text: 'Hvala na pitanju.',
        interest_score: 0.5,
        complexity_score: 0.3,
        phase: 'hook',
      };

      mockStreamLLMResponse.mockReturnValue(
        createMockLLMGenerator(['Hvala ', 'na ', 'pitanju.'], mockResponse),
      );

      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      const turnCompletedHandler = vi.fn();
      orchestrator.on('turnCompleted', turnCompletedHandler);

      const ttm = (orchestrator as unknown as { turnTakingManager: EventEmitter }).turnTakingManager;
      ttm.emit('userFinishedSpeaking', 'Koliko to kosta?');

      await vi.advanceTimersByTimeAsync(100);

      expect(mockStreamLLMResponse).toHaveBeenCalled();
      expect(mockInsertTurn).toHaveBeenCalled();
    });

    it('skips empty transcripts', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      const ttm = (orchestrator as unknown as { turnTakingManager: EventEmitter }).turnTakingManager;
      ttm.emit('userFinishedSpeaking', '   ');

      await vi.advanceTimersByTimeAsync(100);

      expect(mockStreamLLMResponse).not.toHaveBeenCalled();
    });
  });

  describe('handleBargeIn', () => {
    it('cancels TTS playback when barge-in occurs', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      const ttm = (orchestrator as unknown as {
        turnTakingManager: EventEmitter & { setBotSpeaking: ReturnType<typeof vi.fn> };
      }).turnTakingManager;

      ttm.emit('bargeIn');

      expect(ttm.setBotSpeaking).toHaveBeenCalledWith(false);
    });
  });

  describe('handleSilenceTimeout', () => {
    it('plays cached "still there" audio on ask timeout', async () => {
      mockGetCachedAudio.mockResolvedValue(Buffer.from('still-there-audio'));

      const { orchestrator, mediaSession } = createOrchestrator();
      await orchestrator.start();

      const ttm = (orchestrator as unknown as { turnTakingManager: EventEmitter }).turnTakingManager;
      ttm.emit('silenceTimeout', 'ask');

      await vi.advanceTimersByTimeAsync(100);

      expect(mockGetCachedAudio).toHaveBeenCalledWith(
        expect.stringContaining('still_there_bs'),
      );
      expect(mediaSession.sendAudio).toHaveBeenCalled();
    });

    it('calls stop() on end timeout', async () => {
      mockGetCachedAudio.mockResolvedValue(Buffer.from('goodbye-audio'));

      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      const endedHandler = vi.fn();
      orchestrator.on('ended', endedHandler);

      const ttm = (orchestrator as unknown as { turnTakingManager: EventEmitter }).turnTakingManager;
      ttm.emit('silenceTimeout', 'end');

      await vi.advanceTimersByTimeAsync(200);

      expect(mockUpdateCallResult).toHaveBeenCalledWith(
        expect.objectContaining({
          callId: 'test-call-123',
          result: 'timeout',
        }),
      );
      expect(endedHandler).toHaveBeenCalledWith('test-call-123', 'timeout');
    });
  });

  describe('stop()', () => {
    it('saves call result to DB and cleans up resources', async () => {
      const { orchestrator, mediaSession } = createOrchestrator();
      await orchestrator.start();

      const endedHandler = vi.fn();
      orchestrator.on('ended', endedHandler);

      await orchestrator.stop('success');

      expect(mockUpdateCallResult).toHaveBeenCalledWith(
        expect.objectContaining({
          callId: 'test-call-123',
          result: 'success',
        }),
      );

      expect(mockUpsertCallMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          phoneNumber: '+38761000000',
          language: 'bs-BA',
          campaignId: 'campaign-1',
          outcome: 'success',
        }),
      );

      expect(mockInsertMetric).toHaveBeenCalledWith('test-call-123', 'call_duration_sec', expect.any(Number));
      expect(mockInsertMetric).toHaveBeenCalledWith('test-call-123', 'total_turns', 0);

      expect(mediaSession.close).toHaveBeenCalled();
      expect(endedHandler).toHaveBeenCalledWith('test-call-123', 'success');
    });

    it('does not double-stop on repeated calls', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      await orchestrator.stop('success');
      await orchestrator.stop('error');

      expect(mockUpdateCallResult).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleSilencePressure', () => {
    it('plays follow-up prompt from cache', async () => {
      mockGetCachedAudio.mockResolvedValue(Buffer.from('followup-audio'));

      const { orchestrator, mediaSession } = createOrchestrator();
      await orchestrator.start();

      const ttm = (orchestrator as unknown as { turnTakingManager: EventEmitter }).turnTakingManager;
      ttm.emit('silencePressure');

      await vi.advanceTimersByTimeAsync(100);

      expect(mockGetCachedAudio).toHaveBeenCalledWith(
        expect.stringContaining('silence_followup_bs'),
      );
      expect(mediaSession.sendAudio).toHaveBeenCalled();
    });
  });

  describe('media session events', () => {
    it('feeds incoming audio to VAD and ring buffer', async () => {
      const { orchestrator, mediaSession } = createOrchestrator();
      await orchestrator.start();

      const vad = (orchestrator as unknown as { vadDetector: { processAudio: ReturnType<typeof vi.fn> } }).vadDetector;
      const ring = (orchestrator as unknown as { ringBuffer: { write: ReturnType<typeof vi.fn> } }).ringBuffer;

      const audioChunk = Buffer.alloc(320);
      mediaSession.emit('audio', audioChunk);

      expect(vad.processAudio).toHaveBeenCalledWith(audioChunk);
      expect(ring.write).toHaveBeenCalledWith(audioChunk);
    });

    it('stops call when media session stops', async () => {
      const { orchestrator, mediaSession } = createOrchestrator();
      await orchestrator.start();

      mediaSession.emit('stop', { streamId: 'stream-1' });

      await vi.advanceTimersByTimeAsync(100);

      expect(mockUpdateCallResult).toHaveBeenCalledWith(
        expect.objectContaining({
          result: 'no_answer',
        }),
      );
    });

    it('stops call on media session error', async () => {
      const { orchestrator, mediaSession } = createOrchestrator();
      await orchestrator.start();

      mediaSession.emit('error', new Error('WebSocket error'));

      await vi.advanceTimersByTimeAsync(100);

      expect(mockUpdateCallResult).toHaveBeenCalledWith(
        expect.objectContaining({
          result: 'error',
        }),
      );
    });
  });
});
