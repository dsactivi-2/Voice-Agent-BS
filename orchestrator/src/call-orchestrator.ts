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

// Telnyx
import type { MediaStreamSession } from './telnyx/media-stream.js';

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
} from './db/queries.js';

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
  mediaSession: MediaStreamSession;
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
  private readonly mediaSession: MediaStreamSession;

  // ── Per-call components ──────────────────────────────────────────
  private session: CallSession | null = null;
  private memoryManager: MemoryManager | null = null;
  private vadDetector: VADDetector | null = null;
  private turnTakingManager: TurnTakingManager | null = null;
  private ringBuffer: RingBuffer | null = null;

  // ── Per-turn TTS pipeline ────────────────────────────────────────
  private currentTTSPipeline: ChunkedTTSPipeline | null = null;
  private isBotSpeaking: boolean = false;

  // ── Counters and timing ──────────────────────────────────────────
  private turnCounter: number = 0;
  private startTime: number = 0;
  private stopped: boolean = false;

  // ── Processing guard ─────────────────────────────────────────────
  private isProcessingTurn: boolean = false;
  private currentLLMAbortController: AbortController | null = null;

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

      // 3. Initialize ring buffer
      this.ringBuffer = new RingBuffer(config.RING_BUFFER_SIZE_KB);

      // 4. Initialize VAD detector
      this.vadDetector = new VADDetector();

      // 5. Initialize turn-taking manager
      this.turnTakingManager = new TurnTakingManager(this.vadDetector);

      // 6. Bind event handlers
      this.bindMediaSessionEvents();
      this.bindTurnTakingEvents();

      // 7. Persist call record to DB
      await this.safeDbOperation('createCall', () =>
        createCall({
          callId: this.callId,
          phoneNumber: this.phoneNumber,
          language: this.agentConfig.language,
          campaignId: this.campaignId,
          abGroup: this.session!.abGroup,
          llmModeFinal: this.session!.llmMode,
        }),
      );

      this.emit('started', this.callId);

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
      if (this.session && this.memoryManager && config.MEMORY_CROSS_CALL_ENABLED) {
        const avgInterest = this.session.interestScores.length > 0
          ? this.session.interestScores.reduce((a, b) => a + b, 0) / this.session.interestScores.length
          : 0;

        await this.safeDbOperation('upsertCallMemory', () =>
          upsertCallMemory({
            phoneNumber: this.phoneNumber,
            language: this.agentConfig.language,
            campaignId: this.campaignId,
            conversationSummary: this.memoryManager!.getSummary(),
            structuredMemory: this.memoryManager!.getStructuredMemory(),
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

    logger.info(
      { callId: this.callId, result, durationSec, turnCount: this.turnCounter },
      'Call orchestrator stopped',
    );
  }

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

      // Mark that caller has recent audio activity
      if (this.session) {
        this.session.callerSpokeRecently = true;
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
      this.stop('no_answer').catch((err) => {
        logger.error({ err, callId: this.callId }, 'Error during stop after media stream end');
      });
    }
  };

  private onMediaError = (error: Error): void => {
    logger.error({ err: error, callId: this.callId }, 'Media session error');
    if (!this.stopped) {
      this.stop('error').catch((err) => {
        logger.error({ err, callId: this.callId }, 'Error during stop after media error');
      });
    }
  };

  // ════════════════════════════════════════════════════════════════
  // Turn-taking event handlers
  // ════════════════════════════════════════════════════════════════

  private onUserFinishedSpeaking = (transcript: string): void => {
    this.handleUserFinishedSpeaking(transcript).catch((error) => {
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
    this.handleSilenceTimeout(type).catch((error) => {
      logger.error(
        { err: error, callId: this.callId, type },
        'Error handling silence timeout',
      );
    });
  };

  private onSilencePressure = (): void => {
    this.handleSilencePressure().catch((error) => {
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

    // Guard against concurrent turn processing
    if (this.isProcessingTurn) {
      logger.warn(
        { callId: this.callId, transcript },
        'Ignoring overlapping turn — previous turn still processing',
      );
      return;
    }

    this.isProcessingTurn = true;
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
          phase: this.session.phase,
        },
        'Processing user turn',
      );

      // Log user turn to memory manager
      const userTurn: Turn = {
        callId: this.callId,
        turnNumber: currentTurn,
        speaker: 'user',
        text: trimmedTranscript,
        llmMode: this.session.llmMode,
        timestamp: new Date(),
      };
      this.memoryManager.addTurn(userTurn);

      // 1. Select and play filler if needed
      await this.maybePlayFiller(trimmedTranscript);

      // 2. Check if call duration forces close
      if (checkCallDuration(this.session)) {
        this.session.phase = 'close';
        this.turnTakingManager?.setPhase('close');
      }

      // 3. Check LLM switch logic
      if (shouldSwitchToFull(this.session)) {
        const previousMode = this.session.llmMode;
        this.session.llmMode = 'full';
        this.emit('llmSwitched', previousMode, 'full');
        logger.info(
          { callId: this.callId, from: previousMode, to: 'full' },
          'LLM mode switched to full',
        );
      }

      // 4. Process LLM response and pipe to TTS
      await this.processLLMResponse(trimmedTranscript);

      // 5. Calculate and log latency metric
      const totalLatencyMs = Date.now() - turnStartTime;
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
          llmMode: this.session!.llmMode,
        }),
      );

      // 7. Update session turn count
      this.session.turnCount = this.turnCounter;

      this.emit('turnCompleted', currentTurn, this.session.phase);

      logger.info(
        {
          callId: this.callId,
          turn: currentTurn,
          phase: this.session.phase,
          latencyMs: totalLatencyMs,
          llmMode: this.session.llmMode,
        },
        'Turn completed',
      );
    } catch (error) {
      logger.error(
        { err: error, callId: this.callId },
        'Error processing user turn — call continues',
      );
    } finally {
      this.isProcessingTurn = false;
    }
  }

  /**
   * Handles barge-in by cancelling any in-progress TTS playback.
   */
  private handleBargeIn(): void {
    if (this.stopped) return;

    logger.info({ callId: this.callId }, 'Barge-in detected — cancelling TTS playback');

    // Abort any in-flight LLM stream so the generator loop exits
    this.currentLLMAbortController?.abort();
    this.currentLLMAbortController = null;

    // Release the processing guard so the next user turn is not dropped
    this.isProcessingTurn = false;

    // Cancel current TTS pipeline
    if (this.currentTTSPipeline) {
      this.currentTTSPipeline.destroy();
      this.currentTTSPipeline = null;
    }

    // Inform turn-taking that bot stopped speaking
    this.isBotSpeaking = false;
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
        logger.warn(
          { phraseKey, cacheKey, callId: this.callId },
          'Cached phrase not found — skipping playback',
        );
        return;
      }

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
        this.mediaSession.sendAudio(cached);
        logger.debug(
          { fillerType, phrase, callId: this.callId },
          'Filler audio played from cache',
        );
      } else {
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
  private async processLLMResponse(transcript: string): Promise<void> {
    if (this.stopped || !this.session || !this.memoryManager) return;

    const llmStartTime = Date.now();

    // 1. Build LLM context from memory manager
    const messages = this.memoryManager.buildLLMContext(this.agentConfig.systemPrompt);
    messages.push({ role: 'user', content: transcript });

    const model = this.session.llmMode === 'full'
      ? config.LLM_FULL_MODEL
      : config.LLM_MINI_MODEL;

    // 2. Calculate adaptive delay
    const adaptiveDelayMs = calculateAdaptiveDelay(transcript, 0);

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

    let fullResponseText = '';
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
        maxTokens: 300,
        signal: this.currentLLMAbortController.signal,
      });

      let firstTokenReceived = false;
      let result = await generator.next();

      while (!result.done) {
        if (this.stopped) break;

        const token = result.value;
        fullResponseText += token;

        // Log first token latency
        if (!firstTokenReceived) {
          firstTokenReceived = true;
          const firstTokenMs = Date.now() - llmStartTime;
          await this.safeDbOperation('insertFirstTokenMetric', () =>
            insertMetric(this.callId, 'llm_first_token_ms', firstTokenMs),
          );
        }

        // Feed token to TTS pipeline
        this.currentTTSPipeline?.addTokens(token);

        result = await generator.next();
      }

      // The generator returns the parsed LLMResponse when done
      if (result.done && result.value) {
        llmResponse = result.value;
      }

      // 6. Flush remaining TTS buffer
      if (this.currentTTSPipeline) {
        await this.currentTTSPipeline.flush();
      }
    } catch (error) {
      logger.error(
        { err: error, callId: this.callId, model },
        'LLM streaming failed — attempting to continue',
      );

      // Try to flush whatever we have
      if (this.currentTTSPipeline) {
        try {
          await this.currentTTSPipeline.flush();
        } catch (flushErr) {
          logger.error({ err: flushErr, callId: this.callId }, 'TTS flush after LLM error also failed');
        }
      }
    } finally {
      // Clear the LLM abort controller for this turn
      this.currentLLMAbortController = null;

      // Clean up TTS pipeline for this turn
      if (this.currentTTSPipeline) {
        this.currentTTSPipeline.destroy();
        this.currentTTSPipeline = null;
      }

      // Mark bot as no longer speaking
      this.isBotSpeaking = false;
      this.turnTakingManager?.setBotSpeaking(false);
    }

    // 7. Process the LLM response (update session state)
    if (llmResponse && this.session) {
      this.updateSessionFromResponse(llmResponse, fullResponseText);
    }

    // 8. Log LLM latency
    const llmLatencyMs = Date.now() - llmStartTime;
    await this.safeDbOperation('insertLLMLatencyMetric', () =>
      insertMetric(this.callId, 'llm_total_ms', llmLatencyMs),
    );

    // 9. Log bot turn to memory manager and DB
    if (fullResponseText.length > 0 && this.memoryManager) {
      const botTurn: Turn = {
        callId: this.callId,
        turnNumber: this.turnCounter,
        speaker: 'bot',
        text: fullResponseText,
        interestScore: llmResponse?.interest_score,
        complexityScore: llmResponse?.complexity_score,
        llmMode: this.session!.llmMode,
        latencyMs: llmLatencyMs,
        timestamp: new Date(),
      };

      this.memoryManager.addTurn(botTurn);

      await this.safeDbOperation('insertBotTurn', () =>
        insertTurn({
          callId: this.callId,
          turnNumber: this.turnCounter,
          speaker: 'bot',
          text: fullResponseText,
          interestScore: llmResponse?.interest_score,
          complexityScore: llmResponse?.complexity_score,
          llmMode: this.session!.llmMode,
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
    _fullText: string,
  ): void {
    if (!this.session || !this.memoryManager) return;

    // Update interest and complexity scores
    this.session.interestScores.push(llmResponse.interest_score);
    this.session.complexityScore = llmResponse.complexity_score;

    // Update structured memory from LLM response
    this.memoryManager.updateFromLLMResponse(llmResponse);

    // Determine next phase
    const previousPhase = this.session.phase;
    const nextPhase = getNextPhase(this.session, llmResponse);

    if (nextPhase !== previousPhase) {
      this.session.phase = nextPhase;
      this.turnTakingManager?.setPhase(nextPhase);
      this.emit('phaseChanged', previousPhase, nextPhase);

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
