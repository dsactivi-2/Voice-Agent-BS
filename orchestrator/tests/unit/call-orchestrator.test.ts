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
  mockGetCallMemory,
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
  mockGetCallMemory: vi.fn().mockResolvedValue(null), // null = first-time caller by default
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
  getCallMemory: (...args: unknown[]) => mockGetCallMemory(...args),
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
  MemoryManager.prototype.loadCrossCallMemory = vi.fn();
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
    restartSilenceTimer = vi.fn();
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

vi.mock('../../src/deepgram/client.js', async () => {
  const { EventEmitter } = await import('node:events');
  class MockDeepgramASRClient extends EventEmitter {
    connect = vi.fn().mockResolvedValue(undefined);
    sendAudio = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
    isConnected = vi.fn().mockReturnValue(true);
  }
  return { DeepgramASRClient: MockDeepgramASRClient };
});

vi.mock('../../src/metrics/prometheus.js', () => ({
  activeCalls: { inc: vi.fn(), dec: vi.fn() },
  callsTotal: { inc: vi.fn() },
  callDuration: { observe: vi.fn() },
  e2eLatency: { observe: vi.fn() },
  llmLatency: { observe: vi.fn() },
  llmSwitches: { inc: vi.fn() },
  errorsTotal: { inc: vi.fn() },
  ttsCacheHits: { inc: vi.fn() },
  ttsCacheMisses: { inc: vi.fn() },
}));

vi.mock('../../src/events/publisher.js', () => ({
  publishCallEvent: vi.fn().mockResolvedValue(undefined),
}));

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
    clearAudioQueue: vi.fn(),
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

  describe('H2: ASR confidence filter', () => {
    function getAsrClient(orchestrator: CallOrchestrator): EventEmitter {
      return (orchestrator as unknown as { asrClient: EventEmitter }).asrClient;
    }

    function getTurnTakingManager(orchestrator: CallOrchestrator): { onTranscriptReceived: ReturnType<typeof vi.fn> } {
      return (orchestrator as unknown as { turnTakingManager: { onTranscriptReceived: ReturnType<typeof vi.fn> } }).turnTakingManager;
    }

    it('passes high-confidence final transcript to TurnTakingManager', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      const ttm = getTurnTakingManager(orchestrator);
      const asr = getAsrClient(orchestrator);

      asr.emit('transcript', { text: 'Zanima me posao u Njemackoj', isFinal: true, confidence: 0.92, speechFinal: true });

      expect(ttm.onTranscriptReceived).toHaveBeenCalledWith(true, 'Zanima me posao u Njemackoj');
    });

    it('drops low-confidence final transcript (confidence < 0.5)', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      const ttm = getTurnTakingManager(orchestrator);
      const asr = getAsrClient(orchestrator);

      // Live call f856f748 confidence: 0.24 → "Tlancomline" (confirmed garbage)
      asr.emit('transcript', { text: 'Tlancomline', isFinal: true, confidence: 0.24, speechFinal: false });

      expect(ttm.onTranscriptReceived).not.toHaveBeenCalled();
    });

    it('drops final transcript at exactly the threshold boundary (confidence = 0.299)', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      const ttm = getTurnTakingManager(orchestrator);
      const asr = getAsrClient(orchestrator);

      asr.emit('transcript', { text: 'Hmm', isFinal: true, confidence: 0.299, speechFinal: false });

      expect(ttm.onTranscriptReceived).not.toHaveBeenCalled();
    });

    it('accepts final transcript at exactly 0.3 confidence (threshold boundary)', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      const ttm = getTurnTakingManager(orchestrator);
      const asr = getAsrClient(orchestrator);

      asr.emit('transcript', { text: 'Da zanima me', isFinal: true, confidence: 0.3, speechFinal: true });

      expect(ttm.onTranscriptReceived).toHaveBeenCalledWith(true, 'Da zanima me');
    });

    it('drops low-confidence interim transcript (prevents garbage H1 fallback)', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      const ttm = getTurnTakingManager(orchestrator);
      const asr = getAsrClient(orchestrator);

      asr.emit('transcript', { text: 'Tlancomline', isFinal: false, confidence: 0.29, speechFinal: false });

      expect(ttm.onTranscriptReceived).not.toHaveBeenCalled();
    });

    it('passes interim transcript with confidence = 0 (Deepgram omits it on normal interims)', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      const ttm = getTurnTakingManager(orchestrator);
      const asr = getAsrClient(orchestrator);

      // confidence=0 on interims is normal (Deepgram often omits it) — should pass through
      asr.emit('transcript', { text: 'Ne mogu', isFinal: false, confidence: 0, speechFinal: false });

      expect(ttm.onTranscriptReceived).toHaveBeenCalledWith(false, 'Ne mogu');
    });

    it('passes high-confidence interim transcript', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      const ttm = getTurnTakingManager(orchestrator);
      const asr = getAsrClient(orchestrator);

      asr.emit('transcript', { text: 'Zanima me', isFinal: false, confidence: 0.85, speechFinal: false });

      expect(ttm.onTranscriptReceived).toHaveBeenCalledWith(false, 'Zanima me');
    });
  });

  describe('H4: rejection detection', () => {
    function triggerTurnWithScore(orchestrator: CallOrchestrator, score: number): void {
      const session = (orchestrator as unknown as { session: { interestScores: number[]; complexityScore: number; phase: string; conversationSummary: string; structuredMemory: unknown } }).session;
      if (!session) throw new Error('session is null');

      mockGetNextPhase.mockReturnValue(session.phase);

      const mockResponse: LLMResponse = {
        reply_text: 'Razumijem.',
        interest_score: score,
        complexity_score: 0.3,
        phase: session.phase as import('../../src/types.js').Phase,
      };
      mockStreamLLMResponse.mockReturnValue(
        (async function* (): AsyncGenerator<string, LLMResponse> {
          yield '{"reply_text":"Razumijem."}';
          return mockResponse;
        })(),
      );

      const ttm = (orchestrator as unknown as { turnTakingManager: EventEmitter }).turnTakingManager;
      ttm.emit('userFinishedSpeaking', 'Hmm, ne znam.');
    }

    it('does not end call on a single low interest score', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      const endedHandler = vi.fn();
      orchestrator.on('ended', endedHandler);

      triggerTurnWithScore(orchestrator, 0.05);
      await vi.advanceTimersByTimeAsync(200);

      expect(endedHandler).not.toHaveBeenCalled();
    });

    it('ends call with "rejected" after 2 consecutive low interest scores', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      const endedHandler = vi.fn();
      orchestrator.on('ended', endedHandler);

      // Turn 1: score 0.05 — single low, no rejection yet
      triggerTurnWithScore(orchestrator, 0.05);
      await vi.advanceTimersByTimeAsync(200);
      expect(endedHandler).not.toHaveBeenCalled();

      // Turn 2: score 0.08 — second consecutive low → rejection
      triggerTurnWithScore(orchestrator, 0.08);
      await vi.advanceTimersByTimeAsync(200);

      expect(mockUpdateCallResult).toHaveBeenCalledWith(
        expect.objectContaining({ result: 'rejected' }),
      );
      expect(endedHandler).toHaveBeenCalledWith('test-call-123', 'rejected');
    });

    it('does not reject when low score is followed by a normal score', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      const endedHandler = vi.fn();
      orchestrator.on('ended', endedHandler);

      // Turn 1: low
      triggerTurnWithScore(orchestrator, 0.05);
      await vi.advanceTimersByTimeAsync(200);

      // Turn 2: high — streak reset
      triggerTurnWithScore(orchestrator, 0.7);
      await vi.advanceTimersByTimeAsync(200);

      // Turn 3: low again — not consecutive with Turn 1
      triggerTurnWithScore(orchestrator, 0.05);
      await vi.advanceTimersByTimeAsync(200);

      expect(endedHandler).not.toHaveBeenCalled();
    });

    it('does not reject when score is exactly at the threshold (0.1)', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      const endedHandler = vi.fn();
      orchestrator.on('ended', endedHandler);

      // 0.1 is NOT below 0.1 — should NOT trigger rejection
      triggerTurnWithScore(orchestrator, 0.1);
      await vi.advanceTimersByTimeAsync(200);
      triggerTurnWithScore(orchestrator, 0.1);
      await vi.advanceTimersByTimeAsync(200);

      expect(endedHandler).not.toHaveBeenCalled();
    });
  });

  describe('H5: Prometheus metrics', () => {
    async function importMetricMocks() {
      const mocks = await import('../../src/metrics/prometheus.js');
      return {
        activeCalls: mocks.activeCalls as unknown as { inc: ReturnType<typeof vi.fn>; dec: ReturnType<typeof vi.fn> },
        callsTotal: mocks.callsTotal as unknown as { inc: ReturnType<typeof vi.fn> },
        callDuration: mocks.callDuration as unknown as { observe: ReturnType<typeof vi.fn> },
        e2eLatency: mocks.e2eLatency as unknown as { observe: ReturnType<typeof vi.fn> },
        llmLatency: mocks.llmLatency as unknown as { observe: ReturnType<typeof vi.fn> },
        errorsTotal: mocks.errorsTotal as unknown as { inc: ReturnType<typeof vi.fn> },
        ttsCacheHits: mocks.ttsCacheHits as unknown as { inc: ReturnType<typeof vi.fn> },
        ttsCacheMisses: mocks.ttsCacheMisses as unknown as { inc: ReturnType<typeof vi.fn> },
      };
    }

    it('increments activeCalls on start and decrements on stop', async () => {
      const { orchestrator } = createOrchestrator();
      const { activeCalls } = await importMetricMocks();

      await orchestrator.start();
      expect(activeCalls.inc).toHaveBeenCalledWith({ language: 'bs-BA' });

      await orchestrator.stop('success');
      expect(activeCalls.dec).toHaveBeenCalledWith({ language: 'bs-BA' });
    });

    it('increments callsTotal with correct labels on stop', async () => {
      const { orchestrator } = createOrchestrator();
      const { callsTotal } = await importMetricMocks();

      await orchestrator.start();
      await orchestrator.stop('success');

      expect(callsTotal.inc).toHaveBeenCalledWith(
        expect.objectContaining({ language: 'bs-BA', result: 'success' }),
      );
    });

    it('observes callDuration on stop', async () => {
      const { orchestrator } = createOrchestrator();
      const { callDuration } = await importMetricMocks();

      await orchestrator.start();
      await orchestrator.stop('timeout');

      expect(callDuration.observe).toHaveBeenCalledWith(
        { language: 'bs-BA' },
        expect.any(Number),
      );
    });

    it('increments ttsCacheHits when a cached phrase is found', async () => {
      // silence ask → playAudioFromCache('still_there_bs') → getCachedAudio hit
      mockGetCachedAudio.mockResolvedValue(Buffer.from('still-there-audio'));

      const { orchestrator } = createOrchestrator();
      const { ttsCacheHits } = await importMetricMocks();

      await orchestrator.start();

      const ttm = (orchestrator as unknown as { turnTakingManager: EventEmitter }).turnTakingManager;
      ttm.emit('silenceTimeout', 'ask');
      await vi.advanceTimersByTimeAsync(200);

      expect(ttsCacheHits.inc).toHaveBeenCalled();
    });

    it('increments ttsCacheMisses when cached phrase is not found', async () => {
      // silence ask → playAudioFromCache → getCachedAudio returns null → cache miss
      mockGetCachedAudio.mockResolvedValue(null);

      const { orchestrator } = createOrchestrator();
      const { ttsCacheMisses } = await importMetricMocks();

      await orchestrator.start();

      const ttm = (orchestrator as unknown as { turnTakingManager: EventEmitter }).turnTakingManager;
      ttm.emit('silenceTimeout', 'ask');
      await vi.advanceTimersByTimeAsync(200);

      expect(ttsCacheMisses.inc).toHaveBeenCalled();
    });

    it('increments errorsTotal on media session error', async () => {
      const { orchestrator, mediaSession } = createOrchestrator();
      const { errorsTotal } = await importMetricMocks();

      await orchestrator.start();

      mediaSession.emit('error', new Error('WebSocket dropped'));
      await vi.advanceTimersByTimeAsync(100);

      expect(errorsTotal.inc).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'media', type: 'session_error' }),
      );
    });

    it('observes e2eLatency after a completed turn', async () => {
      const mockResponse: LLMResponse = {
        reply_text: 'Hvala.',
        interest_score: 0.5,
        complexity_score: 0.3,
        phase: 'hook',
      };
      mockStreamLLMResponse.mockReturnValue(
        (async function* (): AsyncGenerator<string, LLMResponse> {
          yield '{"reply_text":"Hvala."}';
          return mockResponse;
        })(),
      );

      const { orchestrator } = createOrchestrator();
      const { e2eLatency } = await importMetricMocks();

      await orchestrator.start();

      const ttm = (orchestrator as unknown as { turnTakingManager: EventEmitter }).turnTakingManager;
      ttm.emit('userFinishedSpeaking', 'Zanima me posao.');
      await vi.advanceTimersByTimeAsync(200);

      expect(e2eLatency.observe).toHaveBeenCalledWith(
        expect.objectContaining({ language: 'bs-BA' }),
        expect.any(Number),
      );
    });
  });

  describe('H6: cross-call memory loading', () => {
    function getMemoryManager(orchestrator: CallOrchestrator): { loadCrossCallMemory: ReturnType<typeof vi.fn> } {
      return (orchestrator as unknown as { memoryManager: { loadCrossCallMemory: ReturnType<typeof vi.fn> } }).memoryManager;
    }

    it('calls getCallMemory with phoneNumber and campaignId on start', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      expect(mockGetCallMemory).toHaveBeenCalledWith('+38761000000', 'campaign-1');
    });

    it('calls loadCrossCallMemory when prior memory exists', async () => {
      const priorMemory = {
        id: 'mem-1',
        phone_number: '+38761000000',
        language: 'bs-BA' as const,
        campaign_id: 'campaign-1',
        conversation_summary: 'Korisnik zainteresiran za posao u Njemackoj.',
        structured_memory: {
          objections: ['ne znam jezik'],
          tone: 'skeptical' as const,
          microCommitment: false,
        },
        outcome: 'no_answer',
        sentiment_score: 0.4,
        call_count: 2,
        last_call_at: new Date(),
        created_at: new Date(),
      };
      mockGetCallMemory.mockResolvedValueOnce(priorMemory);

      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      const memMgr = getMemoryManager(orchestrator);
      expect(memMgr.loadCrossCallMemory).toHaveBeenCalledWith({
        summary: 'Korisnik zainteresiran za posao u Njemackoj.',
        structured: {
          objections: ['ne znam jezik'],
          tone: 'skeptical',
          microCommitment: false,
        },
        callCount: 2,
      });
    });

    it('does not call loadCrossCallMemory when no prior memory exists (first-time caller)', async () => {
      mockGetCallMemory.mockResolvedValueOnce(null);

      const { orchestrator } = createOrchestrator();
      await orchestrator.start();

      const memMgr = getMemoryManager(orchestrator);
      expect(memMgr.loadCrossCallMemory).not.toHaveBeenCalled();
    });

    it('proceeds normally when getCallMemory throws (DB down)', async () => {
      mockGetCallMemory.mockRejectedValueOnce(new Error('DB connection refused'));

      const { orchestrator } = createOrchestrator();
      const startedHandler = vi.fn();
      orchestrator.on('started', startedHandler);

      // Should not throw — DB failure is swallowed
      await expect(orchestrator.start()).resolves.toBeUndefined();
      expect(startedHandler).toHaveBeenCalledWith('test-call-123');
    });
  });
});
