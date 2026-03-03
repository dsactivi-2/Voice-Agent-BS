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

// Whisper ASR (Groq primary, OpenAI fallback)
import { WhisperClient } from './asr/whisper-client.js';
import type { ASRLanguage } from './asr/whisper-client.js';
import { SpeechBuffer } from './asr/speech-buffer.js';

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
import { selectFiller } from './filler.js';

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

  // ── Per-call components ──────────────────────────────────────────
  private session: CallSession | null = null;
  private memoryManager: MemoryManager | null = null;
  private vadDetector: VADDetector | null = null;
  private turnTakingManager: TurnTakingManager | null = null;
  private ringBuffer: RingBuffer | null = null;
  private whisperClient: WhisperClient | null = null;
  private speechBuffer: SpeechBuffer | null = null;
  private speechCaptureTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Per-turn TTS pipeline ────────────────────────────────────────
  private currentTTSPipeline: ChunkedTTSPipeline | null = null;
  private isBotSpeaking: boolean = false;
  /** Timestamp when bot stopped speaking — used for echo guard (800ms post-speech). */
  private lastBotSpeakingEndTime: number = 0;

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

  // ── Clarification loop guard ──────────────────────────────────────
  private clarificationCount: number = 0;
  private readonly MAX_CLARIFICATIONS: number = 2;

  constructor(params: CallOrchestratorParams) {
    super();
    this.callId = params.callId;
    this.phoneNumber = params.phoneNumber;
    this.agentConfig = params.agentConfig;
    this.campaignId = params.campaignId;
    this.mediaSession = params.mediaSession;
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

      // 7. Initialize Whisper ASR (REST-based, no WebSocket connection needed)
      this.whisperClient = new WhisperClient(config.GROQ_API_KEY, config.OPENAI_API_KEY);
      this.speechBuffer = new SpeechBuffer();

      const asrLanguage = this.agentConfig.asrLanguage as ASRLanguage;

      // Helper: flush speech buffer and send to Whisper
      const flushSpeechBuffer = () => {
        if (this.speechCaptureTimer) { clearTimeout(this.speechCaptureTimer); this.speechCaptureTimer = null; }

        const audio = this.speechBuffer?.stop();
        if (!audio || audio.length < 1600) return; // <50ms = noise, skip

        const turnId = this.activeTurnId;

        this.whisperClient?.transcribe(audio, asrLanguage)
          .then((text) => {
            if (this.activeTurnId !== turnId) {
              logger.debug({ callId: this.callId, text, reason: 'stale-turn' }, 'Whisper result discarded (barge-in)');
              return;
            }

            const trimmed = text.trim();
            if (trimmed.length === 0) return;

            logger.info(
              { callId: this.callId, text: trimmed, audioBytes: audio.length, durationMs: Math.round(audio.length / 32) },
              'ASR FINAL transcript',
            );

            this.turnTakingManager?.onTranscriptReceived(true, trimmed);
          })
          .catch((err: unknown) => {
            logger.error({ err, callId: this.callId }, 'Whisper transcription failed');
          });
      };

      // VAD speechStart → begin capturing audio
      this.vadDetector.on('speechStart', () => {
        // Echo guard: don't start speech capture while bot is speaking or within
        // 800ms after bot stops. This prevents TTS acoustic echo from being
        // captured and sent to Whisper as if it were customer speech.
        if (this.isBotSpeaking) {
          logger.debug({ callId: this.callId }, 'Ignoring speechStart — bot is speaking');
          return;
        }
        if (this.lastBotSpeakingEndTime > 0 && Date.now() - this.lastBotSpeakingEndTime < 800) {
          logger.debug({ callId: this.callId, msSinceBotStopped: Date.now() - this.lastBotSpeakingEndTime }, 'Ignoring speechStart — echo guard');
          return;
        }

        this.speechBuffer?.startCapture();
        // Safety timer: if speechEnd doesn't fire within 10s, force-flush.
        if (this.speechCaptureTimer) clearTimeout(this.speechCaptureTimer);
        this.speechCaptureTimer = setTimeout(() => {
          if (this.speechBuffer?.isCapturing) {
            logger.warn({ callId: this.callId }, 'Speech capture timeout — forcing flush');
            flushSpeechBuffer();
          }
        }, 10000);
      });

      // VAD speechEnd → send captured audio to Whisper for transcription
      this.vadDetector.on('speechEnd', flushSpeechBuffer);

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
      const greetingTurnId = this.activeTurnId;
      this.isBotSpeaking = true;
      this.turnTakingManager.setBotSpeaking(true);
      const greetingDurationMs = await this.sendGreeting();
      // Keep isBotSpeaking=true until Vonage finishes playing the greeting audio.
      // Clearing it early causes the TTS echo to appear as user speech.
      if (greetingDurationMs > 0) {
        await new Promise(resolve => setTimeout(resolve, greetingDurationMs + 300));
      }
      // Only transition if no barge-in happened during greeting.
      // Barge-in increments activeTurnId and handles isBotSpeaking itself.
      if (this.activeTurnId === greetingTurnId) {
        this.setBotNotSpeaking();
      }
      this.turnTakingManager?.restartSilenceTimer();

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

      // Feed audio to speech buffer (addChunk is a no-op when capture is not active).
      // The echo guard in the speechStart handler prevents capture from starting
      // while bot is speaking or during the 800ms echo tail after bot stops.
      this.speechBuffer?.addChunk(buffer);

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
            whisperActive: this.whisperClient !== null,
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

    // Cancel current TTS pipeline if active
    if (this.currentTTSPipeline) {
      this.currentTTSPipeline.destroy();
      this.currentTTSPipeline = null;
      this.mediaSession.clearAudioQueue();
    }

    // ALWAYS start/restart speech capture — the customer is actively speaking.
    // This bypasses the echo guard in the speechStart handler, ensuring we
    // capture the customer's speech even during greeting playback (from cache).
    this.speechBuffer?.startCapture();
    if (this.speechCaptureTimer) clearTimeout(this.speechCaptureTimer);
    this.speechCaptureTimer = setTimeout(() => {
      if (this.speechBuffer?.isCapturing) {
        logger.warn({ callId: this.callId }, 'Speech capture timeout — forcing flush');
        this.vadDetector?.emit('speechEnd', 0);
      }
    }, 10000);

    // ALWAYS mark bot as not speaking — even during cached greeting (no pipeline).
    // Skip echo guard (lastBotSpeakingEndTime=0) since customer is actively speaking.
    this.isBotSpeaking = false;
    this.lastBotSpeakingEndTime = 0;
    this.turnTakingManager?.setBotSpeaking(false);
  }

  /** Transition bot from speaking → not speaking, recording timestamp for echo guard. */
  private setBotNotSpeaking(): void {
    this.isBotSpeaking = false;
    this.lastBotSpeakingEndTime = Date.now();
    this.turnTakingManager?.setBotSpeaking(false);
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

      // Activate echo guard during cached audio playback.
      // Without this, echo from silence-timeout prompts ("Jeste li jos tu?")
      // would be captured by SpeechBuffer and transcribed as customer speech.
      this.isBotSpeaking = true;
      this.turnTakingManager?.setBotSpeaking(true);

      this.mediaSession.sendAudio(audio);

      // Estimate audio duration and clear isBotSpeaking after playback + buffer.
      // 16kHz 16-bit mono = 32 bytes per ms.
      const durationMs = Math.round(audio.byteLength / 32);
      const turnId = this.activeTurnId;
      setTimeout(() => {
        // Only clear if no barge-in happened during playback
        if (this.activeTurnId === turnId && this.isBotSpeaking) {
          this.setBotNotSpeaking();
        }
      }, durationMs + 300);

      logger.debug(
        { phraseKey, bytes: audio.byteLength, durationMs, callId: this.callId },
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
      const suffix = this.agentConfig.language === 'bs-BA' ? 'bs' : 'sr';
      // Cache key is deterministic: filler_<type>_<lang> — matches the warmup key format.
      // We do not call getFillerPhrase() here because the randomly selected phrase text
      // is not used for the cache lookup; using the type directly guarantees a cache hit.
      const cacheKey = `filler_${fillerType}_${suffix}`;

      const cached = await getCachedAudio(`${cacheKey}:${this.agentConfig.language}`);
      if (cached && this.mediaSession.isOpen()) {
        ttsCacheHits.inc();
        this.mediaSession.sendAudio(cached);
        logger.debug(
          { fillerType, callId: this.callId },
          'Filler audio played from cache',
        );
      } else {
        ttsCacheMisses.inc();
        logger.debug(
          { fillerType, callId: this.callId },
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

    // Prevent intro repetition after the first turn — prompt has the rule,
    // this is a safety-net system message that reinforces it.
    if (this.turnCounter > 1) {
      messages.push({ role: 'system', content: 'REMINDER: Ne ponavljaj pozdrav. Nastavi razgovor.' });
    }

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
    const adaptiveDelayMs = calculateAdaptiveDelay(transcript, actualLatencyMs, this.session.llmMode);

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
        maxTokens: 200,
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
        this.setBotNotSpeaking();
      }
    }

    // 7. Post-LLM guards: sanitize truncated replies, suppress intro repetition, detect clarification loops
    if (llmResponse) {
      const introPattern = /dobar dan.*(?:goran|vesna).*step/i;
      const clarificationPattern = /molim|pojasniti|ponoviti|razumijem\s*\?/i;

      // A. Sanitize truncated replies (missing sentence-ending punctuation)
      const trimmedReply = llmResponse.reply_text.trim();
      if (trimmedReply.length > 0 && !/[.!?\u2026]$/.test(trimmedReply)) {
        if (trimmedReply.length < 10) {
          llmResponse.reply_text = this.agentConfig.cachedPhrases['repeat'] ?? trimmedReply + '.';
          logger.warn({ callId: this.callId, original: trimmedReply }, 'Truncated LLM reply replaced with repeat phrase');
        } else {
          llmResponse.reply_text = trimmedReply + '.';
          logger.warn({ callId: this.callId }, 'Truncated LLM reply — appended period');
        }
      }

      // B. Intro suppression: replace repeated greeting with still_there
      if (this.turnCounter > 1 && introPattern.test(llmResponse.reply_text)) {
        llmResponse.reply_text = this.agentConfig.cachedPhrases['still_there'] ?? 'Jeste li jos tu?';
        logger.warn({ callId: this.callId, turn: this.turnCounter }, 'Intro repetition suppressed');
      }

      // C. Clarification loop: detect "Molim? / Pojasniti?" loops and end call
      if (clarificationPattern.test(llmResponse.reply_text)) {
        this.clarificationCount++;
        if (this.clarificationCount >= this.MAX_CLARIFICATIONS) {
          logger.warn({ callId: this.callId, count: this.clarificationCount }, 'Clarification loop detected — ending call');
          const suffix = this.agentConfig.language === 'bs-BA' ? 'bs' : 'sr';
          void this.playAudioFromCache(`bad_connection_${suffix}`);
          void this.stop('error');
          return;
        }
      } else {
        this.clarificationCount = 0;
      }

      this.updateSessionFromResponse(llmResponse, transcript);
    }

    // 8. Log LLM latency (session may be null if call stopped during streaming)
    const llmLatencyMs = Date.now() - llmStartTime;
    if (this.session) {
      llmLatency.observe({ model, phase: this.session.phase }, llmLatencyMs);
    }


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
        llmMode: this.session?.llmMode ?? 'mini',
        latencyMs: llmLatencyMs,
        timestamp: new Date(),
      };

      this.memoryManager?.addTurn(botTurn);

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

    // Clean up Whisper ASR client and speech buffer
    if (this.speechCaptureTimer) { clearTimeout(this.speechCaptureTimer); this.speechCaptureTimer = null; }
    this.whisperClient = null;
    this.speechBuffer?.clear();
    this.speechBuffer = null;

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
