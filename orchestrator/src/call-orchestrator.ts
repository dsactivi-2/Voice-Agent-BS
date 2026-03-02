import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { logger } from './utils/logger.js';

// Types
import type {
  AgentConfig,
  CallResult,
  CallSession,
  FillerType,
  LLMResponse,
  Phase,
  Turn,
} from './types.js';

// Telephony
import type { MediaSession } from './telephony/provider.js';

// Deepgram ASR
import { DeepgramASRClient } from './deepgram/client.js';
import type { DeepgramLanguage } from './deepgram/client.js';
import type { DeepgramConnectionPool } from './deepgram/connection-pool.js';

// Audio
import { RingBuffer } from './audio/ring-buffer.js';

// VAD + Turn-Taking
import { VADDetector } from './vad/detector.js';
import { TurnTakingManager } from './vad/turn-taking.js';

// LLM
import { streamLLMResponse } from './llm/client.js';
import { MemoryManager } from './llm/memory-manager.js';
import { shouldSwitchToFull } from './llm/switch-logic.js';

// TTS
import { ChunkedTTSPipeline } from './tts/chunked-stream.js';
import { getCachedAudio } from './tts/cache.js';

// Filler
import { selectFiller, getFillerPhrase } from './filler.js';

// Session
import { calculateAdaptiveDelay } from './session/adaptive-delay.js';
import {
  createCallSession,
  getNextPhase,
  checkCallDuration,
} from './session/call-session.js';

// DB
import {
  createCall,
  updateCallResult,
  insertTurn,
  insertMetric,
  upsertCallMemory,
  getCallMemory,
} from './db/queries.js';

// Events
import { publishCallEvent } from './events/publisher.js';

// Prometheus metrics
import {
  activeCalls,
  callsTotal,
  callDuration,
  e2eLatency,
  llmLatency,
  llmSwitches,
  errorsTotal,
  ttsCacheHits,
  ttsCacheMisses,
} from './metrics/prometheus.js';

// ---------------------------------------------------------------------------
// Events emitted by the orchestrator for external observability
// ---------------------------------------------------------------------------

export interface CallOrchestratorEvents {
  started: [callId: string];
  turnCompleted: [turnNumber: number, phase: Phase];
  phaseChanged: [from: Phase, to: Phase];
  llmSwitched: [from: string, to: string];
  ended: [callId: string, result: CallResult];
  error: [error: Error];
}

// ---------------------------------------------------------------------------
// Constructor parameters
// ---------------------------------------------------------------------------

export interface CallOrchestratorParams {
  callId: string;
  phoneNumber: string;
  agentConfig: AgentConfig;
  campaignId: string;
  mediaSession: MediaSession;
  /** Optional pre-warmed connection pool. When provided, acquire/release replaces connect/close. */
  deepgramPool?: DeepgramConnectionPool;
}

// ---------------------------------------------------------------------------
// CallOrchestrator
// ---------------------------------------------------------------------------

/**
 * Manages the complete lifecycle of a single voice call.
 *
 * Wires together the audio pipeline (Telnyx -> RingBuffer -> VAD -> TurnTaking),
 * the language pipeline (Deepgram ASR -> LLM -> TTS), and the state machine
 * (session phases, interest scoring, memory management).
 *
 * Each call gets its own orchestrator instance that is created when a call
 * starts and destroyed when the call ends.
 */
export class CallOrchestrator extends EventEmitter<CallOrchestratorEvents> {
  // ── Immutable configuration ──────────────────────────────────────
  private readonly callId: string;
  private readonly phoneNumber: string;
  private readonly agentConfig: AgentConfig;
  private readonly campaignId: string;
  private readonly mediaSession: MediaSession;
  private readonly deepgramPool: DeepgramConnectionPool | null;

  // ── Per-call components ──────────────────────────────────────────
  private session: CallSession | null = null;
  private memoryManager: MemoryManager | null = null;
  private vadDetector: VADDetector | null = null;
  private turnTakingManager: TurnTakingManager | null = null;
  private ringBuffer: RingBuffer | null = null;
  private asrClient: DeepgramASRClient | null = null;

  // ── Per-turn TTS pipeline ────────────────────────────────────────
  private currentTTSPipeline: ChunkedTTSPipeline | null = null;
  private isBotSpeaking: boolean = false;

  // ── Counters and timing ──────────────────────────────────────────
  private turnCounter: number = 0;
  private startTime: number = 0;
  private stopped: boolean = false;

  // ── Audio throughput tracking ────────────────────────────────────
  private audioBytesSinceLog: number = 0;
  private audioLastLogAt: number = 0;

  // ── Processing guard ─────────────────────────────────────────────
  private isProcessingTurn: boolean = false;
  /** Monotonically increasing counter used to detect stale finally-blocks after barge-in. */
  private activeTurnId: number = 0;
  private currentLLMAbortController: AbortController | null = null;

  constructor(params: CallOrchestratorParams) {
    super();
    this.callId = params.callId;
    this.phoneNumber = params.phoneNumber;
    this.agentConfig = params.agentConfig;
    this.campaignId = params.campaignId;
    this.mediaSession = params.mediaSession;
    this.deepgramPool = params.deepgramPool ?? null;
  }

  // ════════════════════════════════════════════════════════════════
  // Public API
  // ════════════════════════════════════════════════════════════════

  /**
   * Initializes all sub-components and begins processing audio from the
   * media session. This is the entry point after construction.
   */
  async start(): Promise<void> {
    this.startTime = Date.now();
    this.audioLastLogAt = this.startTime;

    logger.info({ callId: this.callId, phoneNumber: this.phoneNumber }, 'Call orchestrator starting');

    try {
      // 1. Create call session
      const { assignABGroup } = await import('./llm/switch-logic.js');
      const abGroup = assignABGroup(this.phoneNumber, this.campaignId);
      const initialMode = abGroup === 'full_only' ? 'full' as const : 'mini' as const;

      this.session = createCallSession({
        callId: this.callId,
        phoneNumber: this.phoneNumber,
        language: this.agentConfig.language,
        campaignId: this.campaignId,
        abGroup,
        initialLLMMode: initialMode,
      });

      // 2. Initialize memory manager
      this.memoryManager = new MemoryManager();

      // 2a. Load cross-call memory for returning callers (non-blocking — DB failure
      //     is logged and swallowed so the call still proceeds for first-time callers).
      //     Skip for 'unknown' phone numbers — these can't be reliably identified as
      //     returning callers and would cause unrelated calls to share the same memory.
      if (config.MEMORY_CROSS_CALL_ENABLED && this.phoneNumber !== 'unknown') {
        try {
          const priorMemory = await getCallMemory(this.phoneNumber, this.campaignId);
          if (priorMemory) {
            this.memoryManager.loadCrossCallMemory({
              summary: priorMemory.conversation_summary,
              structured: priorMemory.structured_memory,
              callCount: priorMemory.call_count,
            });
            logger.info(
              {
                callId: this.callId,
                phoneNumber: this.phoneNumber,
                callCount: priorMemory.call_count,
                hasSummary: !!priorMemory.conversation_summary,
              },
              'Cross-call memory loaded for returning caller',
            );
          }
        } catch (err) {
          logger.warn({ err, callId: this.callId }, 'Failed to load cross-call memory — call proceeds without it');
        }
      }

      // 3. Initialize ring buffer
      this.ringBuffer = new RingBuffer(config.RING_BUFFER_SIZE_KB);

      // 4. Initialize VAD detector
      this.vadDetector = new VADDetector();

      // 5. Initialize turn-taking manager
      this.turnTakingManager = new TurnTakingManager(this.vadDetector);

      // 6. Bind event handlers
      this.bindMediaSessionEvents();
      this.bindTurnTakingEvents();

      // 7. Connect Deepgram ASR — fire-and-forget, don't block start() or greeting.
      //    With a pre-warmed pool the acquire() call returns immediately (no handshake).
      //    Without a pool a fresh connection is created (5s+ handshake, ring buffer covers gap).
      const language = this.agentConfig.deepgramLanguage as DeepgramLanguage;

      const replayRingBuffer = () => {
        const available = this.ringBuffer?.available ?? 0;
        if (available > 0 && this.ringBuffer) {
          const buffered = this.ringBuffer.read(available);
          if (buffered) {
            logger.info(
              { callId: this.callId, bytes: buffered.length },
              'Deepgram connected — replaying buffered audio',
            );
            this.asrClient?.sendAudio(buffered);
          }
        }
      };

      const bindAsrListeners = (client: DeepgramASRClient) => {
        client.on('reconnected', replayRingBuffer);
        client.on('transcript', (event) => {
          // Minimum confidence threshold for accepting transcripts.
          // Proven in live call f856f748: confidence 0.24 produced "Tlancomline" (garbage).
          // Finals below this threshold are dropped entirely; interims are also dropped
          // so they cannot be used as H1 fallback with garbage content.
          const MIN_CONFIDENCE = 0.3;

          if (event.isFinal) {
            if (event.confidence < MIN_CONFIDENCE) {
              logger.warn(
                { callId: this.callId, text: event.text, confidence: event.confidence, threshold: MIN_CONFIDENCE },
                'ASR FINAL transcript dropped — confidence below threshold',
              );
              return;
            }
            logger.info(
              { callId: this.callId, text: event.text, confidence: event.confidence },
              'ASR FINAL transcript',
            );
          } else {
            if (event.confidence < MIN_CONFIDENCE && event.confidence > 0) {
              // confidence=0 on interims is normal (Deepgram omits it) — only warn when explicitly low
              logger.warn(
                { callId: this.callId, text: event.text, confidence: event.confidence },
                'ASR interim transcript dropped — confidence below threshold',
              );
              return;
            }
            logger.debug(
              { callId: this.callId, text: event.text },
              'ASR interim transcript',
            );
          }
          this.turnTakingManager?.onTranscriptReceived(event.isFinal, event.text);
        });
        client.on('error', (error) => {
          logger.error({ err: error, callId: this.callId }, 'Deepgram ASR error');
        });
      };

      // Acquire from pool (no handshake) or create a fresh connection (5s+ handshake).
      // Either way: fire-and-forget so start() doesn't block — ring buffer covers the gap.
      if (this.deepgramPool) {
        this.deepgramPool.acquire(language).then((client) => {
          this.asrClient = client;
          bindAsrListeners(client);
          replayRingBuffer();
        }).catch((error: unknown) => {
          logger.error({ err: error, callId: this.callId }, 'Deepgram pool acquire failed');
        });
      } else {
        const client = new DeepgramASRClient(language, config.DEEPGRAM_API_KEY);
        this.asrClient = client;
        bindAsrListeners(client);
        client.connect().then(replayRingBuffer).catch((error: unknown) => {
          logger.error({ err: error, callId: this.callId }, 'Deepgram ASR failed to connect');
        });
      }

      // 9. Persist call record to DB
      await this.safeDbOperation('createCall', () =>
        createCall({
          callId: this.callId,
          phoneNumber: this.phoneNumber,
          language: this.agentConfig.language,
          campaignId: this.campaignId,
          abGroup: this.session?.abGroup ?? 'mini_only',
          llmModeFinal: this.session?.llmMode ?? 'mini',
        }),
      );

      activeCalls.inc({ language: this.agentConfig.language });
      this.emit('started', this.callId);
      void publishCallEvent({
        type: 'call.started',
        callId: this.callId,
        phoneNumber: this.phoneNumber,
        language: this.agentConfig.language,
        campaignId: this.campaignId,
        abGroup: this.session.abGroup,
        llmMode: this.session.llmMode,
        ts: Date.now(),
      });

      // 10. Send initial greeting — 800ms pause simulates human pickup
      await new Promise(resolve => setTimeout(resolve, 800));
      this.isBotSpeaking = true;
      this.turnTakingManager.setBotSpeaking(true);
      const greetingDurationMs = await this.sendGreeting();
      // Keep isBotSpeaking=true until Vonage finishes playing the greeting audio.
      // Clearing it early causes the TTS echo to appear as user speech.
      if (greetingDurationMs > 0) {
        await new Promise(resolve => setTimeout(resolve, greetingDurationMs + 300));
      }
      this.isBotSpeaking = false;
      this.turnTakingManager.setBotSpeaking(false);
      this.turnTakingManager.restartSilenceTimer();

      logger.info(
        {
          callId: this.callId,
          language: this.agentConfig.language,
          abGroup,
          llmMode: initialMode,
        },
        'Call orchestrator started successfully',
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({ err, callId: this.callId }, 'Failed to start call orchestrator');
      errorsTotal.inc({ service: 'orchestrator', type: 'start_failed' });
      this.emit('error', err);
      throw err;
    }
  }

  /**
   * Gracefully stops the call, persists results and cleans up all resources.
   *
   * @param result - The outcome of the call
   */
  async stop(result: CallResult): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    const durationMs = Date.now() - this.startTime;
    const durationSec = Math.round(durationMs / 1000);

    // Capture before cleanup nullifies this.session
    const language = this.agentConfig.language;
    const abGroup = this.session?.abGroup ?? 'unknown';

    callsTotal.inc({ language, result, ab_group: abGroup });
    callDuration.observe({ language }, durationSec);
    activeCalls.dec({ language });

    logger.info(
      {
        callId: this.callId,
        result,
        durationSec,
        turnCount: this.turnCounter,
      },
      'Call orchestrator stopping',
    );

    try {
      // 1. Save call result to DB
      await this.safeDbOperation('updateCallResult', () =>
        updateCallResult({
          callId: this.callId,
          result,
          durationSec,
          turnCount: this.turnCounter,
        }),
      );

      // 2. Save cross-call memory
      if (this.session && this.memoryManager && config.MEMORY_CROSS_CALL_ENABLED && this.phoneNumber !== 'unknown') {
        const avgInterest = this.session.interestScores.length > 0
          ? this.session.interestScores.reduce((a, b) => a + b, 0) / this.session.interestScores.length
          : 0;

        await this.safeDbOperation('upsertCallMemory', () =>
          upsertCallMemory({
            phoneNumber: this.phoneNumber,
            language: this.agentConfig.language,
            campaignId: this.campaignId,
            conversationSummary: this.memoryManager?.getSummary() ?? '',
            structuredMemory: this.memoryManager?.getStructuredMemory() ?? undefined,
            outcome: result,
            sentimentScore: avgInterest,
          }),
        );
      }

      // 3. Log final metrics
      await this.safeDbOperation('insertFinalMetrics', async () => {
        await insertMetric(this.callId, 'call_duration_sec', durationSec);
        await insertMetric(this.callId, 'total_turns', this.turnCounter);
      });
    } catch (error) {
      logger.error(
        { err: error, callId: this.callId },
        'Error during call stop — continuing with cleanup',
      );
    }

    // 4. Clean up all resources
    this.cleanup();

    this.emit('ended', this.callId, result);
    void publishCallEvent({ type: 'call.ended', callId: this.callId, result, ts: Date.now() });

    logger.info(
      { callId: this.callId, result, durationSec, turnCount: this.turnCounter },
      'Call orchestrator stopped',
    );
  }


  /**
   * Synthesizes and sends the opening greeting to the caller using the
   * agent configured intro phrase. Falls back silently on error.
   */
  private async sendGreeting(): Promise<number> {
    const introText = this.agentConfig.cachedPhrases['intro'];
    if (!introText || this.stopped || !this.mediaSession.isOpen()) return 0;

    try {
      // Try Redis cache first (populated by warmup at startup)
      const langSuffix = this.agentConfig.language === 'sr-RS' ? 'sr' : 'bs';
      const cachedKey = `intro_${langSuffix}:${this.agentConfig.language}`;
      const cached = await getCachedAudio(cachedKey);

      if (cached && this.mediaSession.isOpen()) {
        ttsCacheHits.inc();
        this.mediaSession.sendAudio(cached);
        logger.info({ callId: this.callId, bytes: cached.byteLength }, 'Greeting sent from cache');
        return Math.round(cached.byteLength / (16000 * 2) * 1000);
      }

      // Cache miss - synthesize directly
      ttsCacheMisses.inc();
      const { synthesizeSpeech } = await import('./tts/azure-client.js');
      const audio = await synthesizeSpeech(
        introText,
        this.agentConfig.language,
        this.agentConfig.ttsVoice,
      );

      if (this.mediaSession.isOpen()) {
        this.mediaSession.sendAudio(audio);
        logger.info({ callId: this.callId, bytes: audio.byteLength }, 'Greeting synthesized and sent');
        return Math.round(audio.byteLength / (16000 * 2) * 1000);
      }
      return 0;
    } catch (err) {
      logger.error({ err, callId: this.callId }, 'Failed to send greeting - call continues without it');
      return 0;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // ════════════════════════════════════════════════════════════════
  // Event binding
  // ════════════════════════════════════════════════════════════════

  private bindMediaSessionEvents(): void {
    this.mediaSession.on('audio', this.onMediaAudio);
    this.mediaSession.on('stop', this.onMediaStop);
    this.mediaSession.on('error', this.onMediaError);
  }

  private unbindMediaSessionEvents(): void {
    this.mediaSession.off('audio', this.onMediaAudio);
    this.mediaSession.off('stop', this.onMediaStop);
    this.mediaSession.off('error', this.onMediaError);
  }

  private bindTurnTakingEvents(): void {
    if (!this.turnTakingManager) return;

    this.turnTakingManager.on('userFinishedSpeaking', this.onUserFinishedSpeaking);
    this.turnTakingManager.on('bargeIn', this.onBargeIn);
    this.turnTakingManager.on('silenceTimeout', this.onSilenceTimeout);
    this.turnTakingManager.on('silencePressure', this.onSilencePressure);
  }

  // ════════════════════════════════════════════════════════════════
  // Media session event handlers
  // ════════════════════════════════════════════════════════════════

  private onMediaAudio = (buffer: Buffer): void => {
    if (this.stopped) return;

    try {
      // Write to ring buffer for potential replay/diagnostics
      this.ringBuffer?.write(buffer);

      // Feed to VAD for speech detection
      this.vadDetector?.processAudio(buffer);

      // Stream audio to Deepgram ASR
      this.asrClient?.sendAudio(buffer);

      // Mark that caller has recent audio activity
      if (this.session) {
        this.session.callerSpokeRecently = true;
      }

      // Track audio throughput (log every 5s)
      this.audioBytesSinceLog += buffer.length;
      const now = Date.now();
      if (now - this.audioLastLogAt >= 5000) {
        const intervalSec = (now - this.audioLastLogAt) / 1000;
        logger.info(
          {
            callId: this.callId,
            bytesPerSec: Math.round(this.audioBytesSinceLog / intervalSec),
            deepgramConnected: this.asrClient?.isConnected() ?? false,
          },
          'Audio throughput check',
        );
        this.audioBytesSinceLog = 0;
        this.audioLastLogAt = now;
      }
    } catch (error) {
      logger.error(
        { err: error, callId: this.callId },
        'Error processing incoming audio frame',
      );
    }
  };

  private onMediaStop = (): void => {
    if (!this.stopped) {
      logger.info({ callId: this.callId }, 'Media stream stopped — ending call');
      this.stop('no_answer').catch((err: unknown) => {
        logger.error({ err, callId: this.callId }, 'Error during stop after media stream end');
      });
    }
  };

  private onMediaError = (error: Error): void => {
    logger.error({ err: error, callId: this.callId }, 'Media session error');
    errorsTotal.inc({ service: 'media', type: 'session_error' });
    if (!this.stopped) {
      this.stop('error').catch((err: unknown) => {
        logger.error({ err, callId: this.callId }, 'Error during stop after media error');
      });
    }
  };

  // ════════════════════════════════════════════════════════════════
  // Turn-taking event handlers
  // ════════════════════════════════════════════════════════════════

  private onUserFinishedSpeaking = (transcript: string): void => {
    this.handleUserFinishedSpeaking(transcript).catch((error: unknown) => {
      logger.error(
        { err: error, callId: this.callId, transcript },
        'Error handling user finished speaking',
      );
    });
  };

  private onBargeIn = (): void => {
    this.handleBargeIn();
  };

  private onSilenceTimeout = (type: 'ask' | 'end'): void => {
    this.handleSilenceTimeout(type).catch((error: unknown) => {
      logger.error(
        { err: error, callId: this.callId, type },
        'Error handling silence timeout',
      );
    });
  };

  private onSilencePressure = (): void => {
    this.handleSilencePressure().catch((error: unknown) => {
      logger.error(
        { err: error, callId: this.callId },
        'Error handling silence pressure',
      );
    });
  };

  // ════════════════════════════════════════════════════════════════
  // Core pipeline handlers
  // ════════════════════════════════════════════════════════════════

  /**
   * Handles the complete turn cycle when the user finishes speaking:
   *   1. Play filler audio (if needed)
   *   2. Calculate adaptive delay
   *   3. Check LLM switch logic
   *   4. Build LLM context
   *   5. Stream LLM response
   *   6. Pipe tokens to TTS
   *   7. Update session state
   *   8. Log turn to DB
   */
  private async handleUserFinishedSpeaking(transcript: string): Promise<void> {
    if (this.stopped || !this.session || !this.memoryManager) return;

    // Echo suppression: while bot is speaking, ignore transcripts to prevent
    // TTS acoustic echo from triggering a spurious LLM turn.
    if (this.isBotSpeaking) {
      logger.info({ callId: this.callId, transcript }, 'Ignoring transcript — bot is speaking (echo suppression)');
      return;
    }

    // Capture references now — the call may stop (setting this.session = null)
    // while we are suspended at an await point below.
    const session = this.session;
    const memoryManager = this.memoryManager;

    // Guard against concurrent turn processing
    if (this.isProcessingTurn) {
      logger.warn(
        { callId: this.callId, transcript },
        'Ignoring overlapping turn — previous turn still processing',
      );
      return;
    }

    this.isProcessingTurn = true;
    const myTurnId = ++this.activeTurnId;
    const turnStartTime = Date.now();

    try {
      const trimmedTranscript = transcript.trim();
      if (trimmedTranscript.length === 0) {
        logger.debug({ callId: this.callId }, 'Empty transcript — skipping turn');
        return;
      }

      this.turnCounter++;
      const currentTurn = this.turnCounter;

      logger.info(
        {
          callId: this.callId,
          turn: currentTurn,
          transcript: trimmedTranscript,
          phase: session.phase,
        },
        'Processing user turn',
      );

      // Log user turn to memory manager
      const userTurn: Turn = {
        callId: this.callId,
        turnNumber: currentTurn,
        speaker: 'user',
        text: trimmedTranscript,
        llmMode: session.llmMode,
        timestamp: new Date(),
      };
      memoryManager.addTurn(userTurn);

      // 1. Select and play filler if needed
      await this.maybePlayFiller(trimmedTranscript);

      // 2. Check if call duration forces close
      if (checkCallDuration(session)) {
        session.phase = 'close';
        this.turnTakingManager?.setPhase('close');
      }

      // 3. Check LLM switch logic
      if (shouldSwitchToFull(session)) {
        const previousMode = session.llmMode;
        session.llmMode = 'full';
        llmSwitches.inc({ from_mode: previousMode, to_mode: 'full' });
        this.emit('llmSwitched', previousMode, 'full');
        void publishCallEvent({ type: 'call.llm_switched', callId: this.callId, from: previousMode, to: 'full', ts: Date.now() });
        logger.info(
          { callId: this.callId, from: previousMode, to: 'full' },
          'LLM mode switched to full',
        );
      }

      // 4. Process LLM response and pipe to TTS
      await this.processLLMResponse(trimmedTranscript, turnStartTime);

      // 5. Calculate and log latency metric
      const totalLatencyMs = Date.now() - turnStartTime;
      e2eLatency.observe({ language: this.agentConfig.language, llm_mode: session.llmMode }, totalLatencyMs);
      await this.safeDbOperation('insertLatencyMetric', () =>
        insertMetric(this.callId, 'turn_latency_ms', totalLatencyMs),
      );

      // 6. Log user turn to DB
      await this.safeDbOperation('insertUserTurn', () =>
        insertTurn({
          callId: this.callId,
          turnNumber: currentTurn,
          speaker: 'user',
          text: trimmedTranscript,
          llmMode: session.llmMode,
        }),
      );

      // 7. Update session turn count
      session.turnCount = this.turnCounter;

      this.emit('turnCompleted', currentTurn, session.phase);
      void publishCallEvent({ type: 'call.turn_completed', callId: this.callId, turn: currentTurn, phase: session.phase, ts: Date.now() });

      logger.info(
        {
          callId: this.callId,
          turn: currentTurn,
          phase: session.phase,
          latencyMs: totalLatencyMs,
          llmMode: session.llmMode,
        },
        'Turn completed',
      );
    } catch (error) {
      logger.error(
        { err: error, callId: this.callId },
        'Error processing user turn — call continues',
      );
      errorsTotal.inc({ service: 'orchestrator', type: 'turn_error' });
    } finally {
      // Only reset if this turn is still the active one.
      // Barge-in increments activeTurnId, so a stale finally-block won't
      // clear the guard for the new turn that started after barge-in.
      if (this.activeTurnId === myTurnId) {
        this.isProcessingTurn = false;
      }
    }
  }

  /**
   * Handles barge-in by cancelling any in-progress TTS playback.
   */
  private handleBargeIn(): void {
    if (this.stopped) return;

    logger.info({ callId: this.callId }, 'Barge-in detected — cancelling TTS playback');

    // DO NOT abort the LLM stream — let it complete so we get valid JSON
    // for session context/memory. The streaming loop checks activeTurnId
    // and skips TTS feeding when superseded by barge-in.

    // Increment turn ID BEFORE resetting the processing guard.
    // This ensures any in-flight handleUserFinishedSpeaking finally-block
    // won't see a matching ID and won't clear the guard for the next turn.
    this.activeTurnId++;

    // Release the processing guard so the next user turn is not dropped
    this.isProcessingTurn = false;

    // Cancel current TTS pipeline and clear isBotSpeaking only if pipeline was active.
    // If no pipeline is running (e.g. barge-in during greeting echo), leave isBotSpeaking=true
    // so the greeting duration timer handles the cleanup correctly.
    if (this.currentTTSPipeline) {
      this.currentTTSPipeline.destroy();
      this.currentTTSPipeline = null;
      this.mediaSession.clearAudioQueue();
      this.isBotSpeaking = false;
      this.turnTakingManager?.setBotSpeaking(false);
    }
  }

  /**
   * Handles silence timeout events.
   * - 'ask': play a re-engagement prompt from cache
   * - 'end': terminate the call
   */
  private async handleSilenceTimeout(type: 'ask' | 'end'): Promise<void> {
    if (this.stopped) return;

    logger.info({ callId: this.callId, type }, 'Silence timeout triggered');

    if (type === 'ask') {
      // Play "Jeste li jos tu?" from cache
      const suffix = this.agentConfig.language === 'bs-BA' ? 'bs' : 'sr';
      await this.playAudioFromCache(`still_there_${suffix}`);
    } else {
      // End the call
      logger.info({ callId: this.callId }, 'Silence timeout (end) — hanging up');

      // Try to play goodbye before hanging up
      const suffix = this.agentConfig.language === 'bs-BA' ? 'bs' : 'sr';
      await this.playAudioFromCache(`goodbye_${suffix}`);

      await this.stop('timeout');
    }
  }

  /**
   * Handles silence pressure by playing a follow-up prompt.
   * Only active during the close phase.
   */
  private async handleSilencePressure(): Promise<void> {
    if (this.stopped) return;

    logger.debug({ callId: this.callId }, 'Silence pressure — playing follow-up');

    const suffix = this.agentConfig.language === 'bs-BA' ? 'bs' : 'sr';
    await this.playAudioFromCache(`silence_followup_${suffix}`);
  }

  // ════════════════════════════════════════════════════════════════
  // Audio playback helpers
  // ════════════════════════════════════════════════════════════════

  /**
   * Retrieves a pre-synthesized phrase from the TTS cache and sends
   * it to the caller via the media session.
   *
   * @param phraseKey - Cache key for the phrase (without language suffix)
   */
  private async playAudioFromCache(phraseKey: string): Promise<void> {
    if (this.stopped || !this.mediaSession.isOpen()) return;

    const language = this.agentConfig.language;
    const cacheKey = `${phraseKey}:${language}`;

    try {
      const audio = await getCachedAudio(cacheKey);

      if (audio === null) {
        ttsCacheMisses.inc();
        logger.warn(
          { phraseKey, cacheKey, callId: this.callId },
          'Cached phrase not found — skipping playback',
        );
        return;
      }

      ttsCacheHits.inc();
      this.mediaSession.sendAudio(audio);

      logger.debug(
        { phraseKey, bytes: audio.byteLength, callId: this.callId },
        'Cached audio played',
      );
    } catch (error) {
      logger.error(
        { err: error, phraseKey, callId: this.callId },
        'Failed to play cached audio — continuing',
      );
    }
  }

  /**
   * Optionally plays a filler phrase while waiting for the LLM.
   */
  private async maybePlayFiller(transcript: string): Promise<void> {
    if (!this.session) return;

    const fillerType: FillerType | null = selectFiller(this.session, transcript);

    if (fillerType === null) return;

    try {
      const phrase = getFillerPhrase(this.agentConfig, fillerType);
      const suffix = this.agentConfig.language === 'bs-BA' ? 'bs' : 'sr';
      const cacheKey = `filler_${fillerType}_${suffix}`;

      // Try cached version first
      const cached = await getCachedAudio(`${cacheKey}:${this.agentConfig.language}`);
      if (cached && this.mediaSession.isOpen()) {
        ttsCacheHits.inc();
        this.mediaSession.sendAudio(cached);
        logger.debug(
          { fillerType, phrase, callId: this.callId },
          'Filler audio played from cache',
        );
      } else {
        ttsCacheMisses.inc();
        logger.debug(
          { fillerType, phrase, callId: this.callId },
          'Filler cache miss — skipping filler playback',
        );
      }
    } catch (error) {
      logger.warn(
        { err: error, fillerType, callId: this.callId },
        'Failed to play filler — continuing without filler',
      );
    }
  }

  // ════════════════════════════════════════════════════════════════
  // LLM + TTS pipeline
  // ════════════════════════════════════════════════════════════════

  /**
   * Streams an LLM response and pipes the tokens through the chunked
   * TTS pipeline for real-time audio synthesis.
   *
   * @param transcript - The user's transcribed speech
   */
  private async processLLMResponse(transcript: string, turnStartTime: number): Promise<void> {
    if (this.stopped || !this.session || !this.memoryManager) return;

    const llmStartTime = Date.now();

    // 1. Build LLM context from memory manager
    const messages = this.memoryManager.buildLLMContext(this.agentConfig.systemPrompt);
    messages.push({ role: 'user', content: transcript });

    // Capture turn ID — if barge-in fires, activeTurnId increments and we stop feeding TTS.
    const myProcessTurnId = this.activeTurnId;

    const model = this.session.llmMode === 'full'
      ? config.LLM_FULL_MODEL
      : config.LLM_MINI_MODEL;

    logger.info(
      {
        callId: this.callId,
        turn: this.turnCounter,
        llm_mode: this.session.llmMode,
        model_name: model,
        phase: this.session.phase,
        interest_scores: this.session.interestScores.slice(-3),
        complexity_score: this.session.complexityScore,
        ab_group: this.session.abGroup,
      },
      'LLM_TURN_START',
    );

    // 2. Calculate adaptive delay — subtract filler+processing latency already elapsed
    const actualLatencyMs = Date.now() - turnStartTime;
    const adaptiveDelayMs = calculateAdaptiveDelay(transcript, actualLatencyMs);

    // 3. Create a new TTS pipeline for this turn
    this.currentTTSPipeline = new ChunkedTTSPipeline(
      this.agentConfig.language,
      this.agentConfig.ttsVoice || undefined,
      (audio: Buffer, _text: string) => {
        if (this.stopped || !this.mediaSession.isOpen()) return;
        this.mediaSession.sendAudio(audio);
      },
    );

    // Mark bot as speaking
    this.isBotSpeaking = true;
    this.turnTakingManager?.setBotSpeaking(true);

    let llmResponse: LLMResponse | null = null;

    try {
      // 4. Apply adaptive delay if needed
      if (adaptiveDelayMs > 0) {
        await this.delay(adaptiveDelayMs);
      }

      // 5. Stream LLM response
      this.currentLLMAbortController = new AbortController();
      const generator = streamLLMResponse({
        model,
        messages,
        maxTokens: 120,
        signal: this.currentLLMAbortController.signal,
      });

      // State machine to extract only reply_text from streaming JSON
      let jsonTTSBuffer = '';
      let jsonTTSState: 'seeking' | 'in_value' | 'done' = 'seeking';
      let jsonTTSEscaped = false;

      let result = await generator.next();
      for (;;) {
        if (result.done) { break; }
        const token = result.value;

        // Feed only the reply_text value from the JSON response to TTS.
        // The LLM streams raw JSON tokens — we must skip keys/syntax.
        for (const ch of token) {
          jsonTTSBuffer += ch;

          if (jsonTTSState === 'done') continue;

          if (jsonTTSState === 'seeking') {
            const match = jsonTTSBuffer.match(/"reply_text"\s*:\s*"([\s\S]*)$/);
            if (match) {
              jsonTTSState = 'in_value';
              const captured = match[1] ?? '';
              jsonTTSBuffer = '';
              if (captured && this.activeTurnId === myProcessTurnId) this.currentTTSPipeline?.addTokens(captured);
            }
          } else {
            if (jsonTTSEscaped) {
              const unescaped = ch === 'n' ? '\n' : ch === 't' ? '\t' : ch;
              if (this.activeTurnId === myProcessTurnId) this.currentTTSPipeline?.addTokens(unescaped);
              jsonTTSEscaped = false;
            } else if (ch === '\\') {
              jsonTTSEscaped = true;
            } else if (ch === '"') {
              jsonTTSState = 'done';
            } else {
              if (this.activeTurnId === myProcessTurnId) this.currentTTSPipeline?.addTokens(ch);
            }
          }
        }

        result = await generator.next();
      }

      // The generator returns the parsed LLMResponse when done
      llmResponse = result.value;
      // 6. Flush remaining TTS buffer (pipeline may be null if barge-in fired)
      if (this.activeTurnId === myProcessTurnId) await this.currentTTSPipeline?.flush();


    } catch (error) {
      logger.error(
        { err: error, callId: this.callId, model },
        'LLM streaming failed — attempting to continue',
      );
      errorsTotal.inc({ service: 'llm', type: error instanceof Error ? error.constructor.name : 'unknown' });

      logger.warn(
        {
          callId: this.callId,
          turn: this.turnCounter,
          model_name: model,
          error_type: error instanceof Error ? error.constructor.name : 'unknown',
        },
        'LLM_TURN_FALLBACK',
      );

      // Try to flush whatever we have (pipeline may already be null if barge-in destroyed it)
      try {
        await this.currentTTSPipeline?.flush();
      } catch (flushErr) {
        logger.error({ err: flushErr, callId: this.callId }, 'TTS flush after LLM error also failed');
      }


    } finally {
      // Only clean up shared state if this is still the active turn.
      // If barge-in fired, the new turn owns these resources.
      if (this.activeTurnId === myProcessTurnId) {
        this.currentLLMAbortController = null;
        this.currentTTSPipeline?.destroy();
        this.currentTTSPipeline = null;
        this.isBotSpeaking = false;
        this.turnTakingManager?.setBotSpeaking(false);
      }
    }

    // 7. Process the LLM response (update session state)
    if (llmResponse) {
      this.updateSessionFromResponse(llmResponse, transcript);
    }

    // 8. Log LLM latency
    const llmLatencyMs = Date.now() - llmStartTime;
    llmLatency.observe({ model, phase: this.session.phase }, llmLatencyMs);


    await this.safeDbOperation('insertLLMLatencyMetric', () =>
      insertMetric(this.callId, 'llm_total_ms', llmLatencyMs),
    );

    // 9. Log bot turn to memory manager and DB
    // Only store when LLM completed fully (reply_text parsed).
    // Aborted/barge-in turns have llmResponse=null — skip to avoid storing partial JSON.
    if (llmResponse) {
      const botText = llmResponse.reply_text;
      const botTurn: Turn = {
        callId: this.callId,
        turnNumber: this.turnCounter,
        speaker: 'bot',
        text: botText,
        interestScore: llmResponse.interest_score,
        complexityScore: llmResponse.complexity_score,
        llmMode: this.session.llmMode,
        latencyMs: llmLatencyMs,
        timestamp: new Date(),
      };

      this.memoryManager.addTurn(botTurn);

      await this.safeDbOperation('insertBotTurn', () =>
        insertTurn({
          callId: this.callId,
          turnNumber: this.turnCounter,
          speaker: 'bot',
          text: botText,
          interestScore: llmResponse.interest_score,
          complexityScore: llmResponse.complexity_score,
          llmMode: this.session?.llmMode ?? 'mini',
          latencyMs: llmLatencyMs,
        }),
      );
    }
  }

  // ════════════════════════════════════════════════════════════════
  // Session state management
  // ════════════════════════════════════════════════════════════════

  /**
   * Updates the call session based on the LLM response: scores, phase
   * transitions, and structured memory.
   */
  private updateSessionFromResponse(
    llmResponse: LLMResponse,
    userTranscript: string,
  ): void {
    if (!this.session || !this.memoryManager) return;

    // Update interest and complexity scores
    this.session.interestScores.push(llmResponse.interest_score);
    this.session.complexityScore = llmResponse.complexity_score;

    // H4: End call after 2 consecutive very low interest scores (rejection signal).
    // Threshold 0.1 = explicit disinterest ("ne zanima me", "nemam vremena", etc.)
    const REJECTION_THRESHOLD = 0.1;
    const REJECTION_STREAK = 2;
    const scores = this.session.interestScores;
    if (scores.length >= REJECTION_STREAK) {
      const recent = scores.slice(-REJECTION_STREAK);
      if (recent.every((s) => s < REJECTION_THRESHOLD)) {
        logger.info(
          { callId: this.callId, recentScores: recent },
          'Consecutive low interest scores — ending call as rejected',
        );
        void this.stop('rejected');
        return;
      }
    }

    // Update structured memory based on what the user said
    this.memoryManager.updateFromLLMResponse(llmResponse, userTranscript);

    // Determine next phase based on user's transcript (not bot reply)
    const previousPhase = this.session.phase;
    const nextPhase = getNextPhase(this.session, llmResponse, userTranscript);

    if (nextPhase !== previousPhase) {
      this.session.phase = nextPhase;
      this.turnTakingManager?.setPhase(nextPhase);
      this.emit('phaseChanged', previousPhase, nextPhase);
      void publishCallEvent({ type: 'call.phase_changed', callId: this.callId, from: previousPhase, to: nextPhase, ts: Date.now() });

      logger.info(
        { callId: this.callId, from: previousPhase, to: nextPhase },
        'Session phase updated',
      );
    }

    // Update conversation summary in session
    this.session.conversationSummary = this.memoryManager.getSummary();
    this.session.structuredMemory = this.memoryManager.getStructuredMemory();
  }

  // ════════════════════════════════════════════════════════════════
  // Cleanup
  // ════════════════════════════════════════════════════════════════

  /**
   * Destroys all sub-components and removes all event listeners.
   */
  private cleanup(): void {
    // Unbind media session events
    this.unbindMediaSessionEvents();

    // Close Deepgram ASR connection (or release back to pool)
    if (this.asrClient) {
      if (this.deepgramPool) {
        this.deepgramPool.release(this.asrClient);
      } else {
        void this.asrClient.close();
      }
      this.asrClient = null;
    }

    // Destroy TTS pipeline if active
    if (this.currentTTSPipeline) {
      this.currentTTSPipeline.destroy();
      this.currentTTSPipeline = null;
    }

    // Destroy turn-taking manager
    if (this.turnTakingManager) {
      this.turnTakingManager.destroy();
      this.turnTakingManager = null;
    }

    // Destroy VAD detector
    if (this.vadDetector) {
      this.vadDetector.destroy();
      this.vadDetector = null;
    }

    // Clear ring buffer
    if (this.ringBuffer) {
      this.ringBuffer.clear();
      this.ringBuffer = null;
    }

    // Reset memory manager
    if (this.memoryManager) {
      this.memoryManager.reset();
      this.memoryManager = null;
    }

    // Close media session
    this.mediaSession.close();

    // Clear session
    this.session = null;

    logger.info({ callId: this.callId }, 'Call orchestrator resources cleaned up');
  }

  // ════════════════════════════════════════════════════════════════
  // Utility helpers
  // ════════════════════════════════════════════════════════════════

  /**
   * Wraps a DB operation in a try/catch to prevent DB failures from
   * crashing the call. Errors are logged but not re-thrown.
   */
  private async safeDbOperation(
    operationName: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    try {
      await fn();
    } catch (error) {
      logger.error(
        { err: error, callId: this.callId, operation: operationName },
        `DB operation failed: ${operationName} — call continues`,
      );
    }
  }

  /**
   * Returns a promise that resolves after the given number of milliseconds.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
