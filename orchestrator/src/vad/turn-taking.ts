import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { VADDetector } from './detector.js';
import type { Phase } from '../types.js';

export interface TurnTakingEvents {
  /** User started speaking (confirmed by VAD min duration). */
  userStartedSpeaking: [];
  /** User finished speaking and a final transcript is available. */
  userFinishedSpeaking: [transcript: string];
  /** User spoke over the bot's TTS playback (barge-in). */
  bargeIn: [];
  /** Extended silence detected. Type indicates the escalation level. */
  silenceTimeout: [type: 'ask' | 'end'];
  /** Silence pressure in the close phase — nudge the user to respond. */
  silencePressure: [];
}

export interface TurnTakingOptions {
  /** Minimum speech duration to qualify as a barge-in (ms). */
  bargeInMinMs?: number;
  /** First-tier silence timeout (ms). Triggers a re-engagement prompt. */
  silenceTimeoutMs?: number;
  /** Second-tier silence timeout (ms). Triggers call end. */
  silenceEndMs?: number;
  /** Silence pressure delay after entering close phase (ms). */
  silencePressureMs?: number;
}

/**
 * Coordinates VAD events with the conversation flow to manage turn-taking.
 *
 * Responsibilities:
 *  - Detects barge-in when the user speaks over the bot
 *  - Waits for a final Deepgram transcript before signalling turn completion
 *  - Monitors silence and emits escalating timeout events
 *  - Applies silence pressure in the close phase to prompt the user
 */
export class TurnTakingManager extends EventEmitter<TurnTakingEvents> {
  private readonly bargeInMinMs: number;
  private readonly silenceTimeoutMs: number;
  private readonly silenceEndMs: number;
  private readonly silencePressureMs: number;

  private readonly vadDetector: VADDetector;

  /** Whether the bot is currently playing TTS audio. */
  private botSpeaking: boolean = false;

  /** Whether the user is currently speaking (per VAD). */
  private userSpeaking: boolean = false;

  /** Timestamp when the current speech run started. */
  private speechStartedAt: number = 0;

  /** Whether a barge-in event was already emitted for the current speech run. */
  private bargeInEmitted: boolean = false;

  /** The latest pending final transcript, buffered until VAD confirms speech end. */
  private pendingFinalTranscript: string | null = null;

  /** Whether we are waiting for a final transcript after VAD speechEnd. */
  private waitingForFinal: boolean = false;

  /** Last interim transcript received — used as fallback if no final arrives. */
  private lastInterimTranscript: string = '';

  /** Timer for the waiting-for-final safety net. */
  private finalTranscriptTimerId: ReturnType<typeof setTimeout> | null = null;

  /** Current conversation phase. */
  private phase: Phase = 'hook';

  // ── Silence monitoring ──────────────────────────────────────────

  /** Timer for the first silence timeout ('ask'). */
  private silenceAskTimerId: ReturnType<typeof setTimeout> | null = null;

  /** Timer for the second silence timeout ('end'). */
  private silenceEndTimerId: ReturnType<typeof setTimeout> | null = null;

  /** Whether the first silence timeout has already fired. */
  private silenceAskFired: boolean = false;

  // ── Silence pressure ────────────────────────────────────────────

  /** Timer for silence pressure in the close phase. */
  private silencePressureTimerId: ReturnType<typeof setTimeout> | null = null;

  private destroyed: boolean = false;

  constructor(vadDetector: VADDetector, options: TurnTakingOptions = {}) {
    super();

    this.vadDetector = vadDetector;
    this.bargeInMinMs = options.bargeInMinMs ?? config.VAD_BARGE_IN_MIN_MS;
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? config.VAD_SILENCE_TIMEOUT_MS;
    this.silenceEndMs = options.silenceEndMs ?? config.VAD_SILENCE_TIMEOUT_MS * 2;
    this.silencePressureMs = options.silencePressureMs ?? config.SILENCE_PRESSURE_AFTER_OFFER_MS;

    this.bindVADEvents();
    this.startSilenceMonitor();

    logger.debug(
      {
        bargeInMinMs: this.bargeInMinMs,
        silenceTimeoutMs: this.silenceTimeoutMs,
        silenceEndMs: this.silenceEndMs,
        silencePressureMs: this.silencePressureMs,
      },
      'TurnTakingManager initialised',
    );
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Informs the manager whether the bot is currently playing TTS.
   * This is needed to detect barge-in events.
   */
  setBotSpeaking(speaking: boolean): void {
    this.botSpeaking = speaking;

    logger.trace({ botSpeaking: speaking }, 'TurnTaking: botSpeaking updated');
  }

  /**
   * Sets the current conversation phase. Silence pressure is only
   * active during the 'close' phase.
   */
  setPhase(phase: Phase): void {
    const previousPhase = this.phase;
    this.phase = phase;

    // Manage silence pressure based on phase transitions
    if (phase === 'close' && previousPhase !== 'close') {
      this.startSilencePressure();
    } else if (phase !== 'close') {
      this.clearSilencePressure();
    }

    logger.debug({ phase, previousPhase }, 'TurnTaking: phase updated');
  }

  /**
   * Called when Deepgram delivers a transcript result.
   *
   * @param isFinal - Whether this is a FINAL result (utterance complete)
   * @param text    - The transcript text
   */
  onTranscriptReceived(isFinal: boolean, text: string): void {
    if (this.destroyed) return;

    if (!isFinal) {
      const trimmedInterim = text.trim();
      if (trimmedInterim.length > 0) {
        this.lastInterimTranscript = trimmedInterim;
      }
      logger.debug({ text: trimmedInterim }, 'TurnTaking: interim transcript');
      return;
    }

    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    logger.debug({ isFinal, text: trimmed, waitingForFinal: this.waitingForFinal }, 'TurnTaking: transcript received');

    if (this.waitingForFinal) {
      // VAD already signalled speechEnd — emit immediately
      this.waitingForFinal = false;
      this.lastInterimTranscript = '';
      this.clearFinalTranscriptTimer();
      this.emitUserFinished(trimmed);
    } else {
      // Buffer the transcript until VAD signals speechEnd
      this.pendingFinalTranscript = trimmed;
      this.lastInterimTranscript = '';
    }
  }

  /**
   * Restarts the silence monitor timers from zero.
   * Call this after the bot finishes playing a greeting or audio chunk
   * to give the caller a full silence window to respond.
   */
  restartSilenceTimer(): void {
    if (this.destroyed) return;
    this.startSilenceMonitor();
    logger.debug('TurnTaking: silence timer restarted');
  }

  /**
   * Resets all internal state to the initial configuration.
   */
  reset(): void {
    this.clearAllTimers();

    this.botSpeaking = false;
    this.userSpeaking = false;
    this.speechStartedAt = 0;
    this.bargeInEmitted = false;
    this.pendingFinalTranscript = null;
    this.waitingForFinal = false;
    this.lastInterimTranscript = '';
    this.phase = 'hook';
    this.silenceAskFired = false;

    this.startSilenceMonitor();

    logger.debug('TurnTakingManager reset');
  }

  /**
   * Permanently destroys the manager. No further events will be emitted.
   */
  destroy(): void {
    this.destroyed = true;
    this.clearAllTimers();
    this.unbindVADEvents();
    this.removeAllListeners();

    logger.debug('TurnTakingManager destroyed');
  }

  // ── VAD Event Binding ───────────────────────────────────────────

  private onSpeechStart = (): void => {
    if (this.destroyed) return;

    this.userSpeaking = true;
    this.speechStartedAt = Date.now();
    this.bargeInEmitted = false;

    // Reset silence monitors — user is talking
    this.resetSilenceMonitor();

    this.emit('userStartedSpeaking');

    // Check for barge-in
    if (this.botSpeaking) {
      this.scheduleBargeinCheck();
    }

    logger.debug('TurnTaking: user started speaking');
  };

  private onSpeechEnd = (_durationMs: number): void => {
    if (this.destroyed) return;

    this.userSpeaking = false;

    // Restart silence monitoring now that the user stopped talking
    this.startSilenceMonitor();

    // Restart silence pressure if we are in the close phase
    if (this.phase === 'close') {
      this.startSilencePressure();
    }

    // Check if we already have a buffered final transcript
    if (this.pendingFinalTranscript !== null) {
      const transcript = this.pendingFinalTranscript;
      this.pendingFinalTranscript = null;
      this.emitUserFinished(transcript);
    } else {
      // Wait for the final transcript from Deepgram
      this.waitingForFinal = true;
      this.startFinalTranscriptTimer();
    }

    logger.debug('TurnTaking: user stopped speaking, awaiting final transcript');
  };

  private bindVADEvents(): void {
    this.vadDetector.on('speechStart', this.onSpeechStart);
    this.vadDetector.on('speechEnd', this.onSpeechEnd);
  }

  private unbindVADEvents(): void {
    this.vadDetector.off('speechStart', this.onSpeechStart);
    this.vadDetector.off('speechEnd', this.onSpeechEnd);
  }

  // ── Barge-In ────────────────────────────────────────────────────

  /**
   * Schedules a check after bargeInMinMs to confirm the speech is real
   * (not a short noise burst) before emitting the barge-in event.
   */
  private scheduleBargeinCheck(): void {
    // The VAD already filters short noise at the detector level,
    // but we add an additional check here at the turn-taking level
    // to confirm the speech duration exceeds the barge-in threshold.
    const elapsed = Date.now() - this.speechStartedAt;

    if (elapsed >= this.bargeInMinMs) {
      this.emitBargeIn();
    } else {
      // Check again after the remaining time
      const remaining = this.bargeInMinMs - elapsed;
      setTimeout(() => {
        if (this.destroyed) return;
        if (this.userSpeaking && this.botSpeaking && !this.bargeInEmitted) {
          this.emitBargeIn();
        }
      }, remaining);
    }
  }

  private emitBargeIn(): void {
    if (this.bargeInEmitted) return;

    this.bargeInEmitted = true;
    this.emit('bargeIn');

    logger.info('TurnTaking: barge-in detected');
  }

  // ── User Finished ───────────────────────────────────────────────

  private emitUserFinished(transcript: string): void {
    this.emit('userFinishedSpeaking', transcript);

    logger.debug({ transcript }, 'TurnTaking: user finished speaking');
  }

  // ── Final Transcript Safety Timer ───────────────────────────────

  /**
   * If Deepgram does not send a final transcript within a reasonable window
   * after VAD speechEnd, we give up waiting.
   */
  private startFinalTranscriptTimer(): void {
    this.clearFinalTranscriptTimer();

    this.finalTranscriptTimerId = setTimeout(() => {
      if (this.destroyed) return;

      if (this.waitingForFinal) {
        this.waitingForFinal = false;
        this.finalTranscriptTimerId = null;

        const fallback = this.lastInterimTranscript;
        this.lastInterimTranscript = '';

        // Check that the fallback contains at least one real word (>3 letters),
        // not just ASR garbage like "Tlan" or random consonant clusters.
        const hasRealWord = fallback.split(/\s+/).some(
          (w) => w.replace(/[^a-zA-Z\u010D\u0107\u0161\u017E\u0111\u010C\u0106\u0160\u017D\u0110]/g, '').length > 3,
        );

        if (hasRealWord) {
          // Use the last interim transcript as a best-effort fallback
          logger.warn(
            { fallbackTranscript: fallback },
            'TurnTaking: final transcript timeout — using last interim as fallback',
          );
          this.emitUserFinished(fallback);
        } else {
          // No usable interim either — log and restart silence monitor so the
          // user gets a chance to respond (instead of a stuck dead state).
          logger.warn('TurnTaking: final transcript timeout — no interim available, restarting silence monitor');
          this.startSilenceMonitor();
        }
        return;
      }

      this.finalTranscriptTimerId = null;
    }, 3000); // 3s safety net
  }

  private clearFinalTranscriptTimer(): void {
    if (this.finalTranscriptTimerId !== null) {
      clearTimeout(this.finalTranscriptTimerId);
      this.finalTranscriptTimerId = null;
    }
  }

  // ── Silence Monitoring ──────────────────────────────────────────

  private startSilenceMonitor(): void {
    this.clearSilenceTimers();
    this.silenceAskFired = false;

    // First tier: "ask" — re-engagement prompt
    this.silenceAskTimerId = setTimeout(() => {
      if (this.destroyed || this.userSpeaking) return;

      this.silenceAskFired = true;
      this.silenceAskTimerId = null;
      this.emit('silenceTimeout', 'ask');

      logger.info({ timeoutMs: this.silenceTimeoutMs }, 'TurnTaking: silence timeout (ask)');

      // Second tier: "end" — terminate the call
      this.silenceEndTimerId = setTimeout(() => {
        if (this.destroyed || this.userSpeaking) return;

        this.silenceEndTimerId = null;
        this.emit('silenceTimeout', 'end');

        logger.info({ timeoutMs: this.silenceEndMs }, 'TurnTaking: silence timeout (end)');
      }, this.silenceEndMs - this.silenceTimeoutMs);
    }, this.silenceTimeoutMs);
  }

  private resetSilenceMonitor(): void {
    this.clearSilenceTimers();
    this.silenceAskFired = false;
  }

  private clearSilenceTimers(): void {
    if (this.silenceAskTimerId !== null) {
      clearTimeout(this.silenceAskTimerId);
      this.silenceAskTimerId = null;
    }
    if (this.silenceEndTimerId !== null) {
      clearTimeout(this.silenceEndTimerId);
      this.silenceEndTimerId = null;
    }
  }

  // ── Silence Pressure ────────────────────────────────────────────

  private startSilencePressure(): void {
    this.clearSilencePressure();

    this.silencePressureTimerId = setTimeout(() => {
      if (this.destroyed || this.userSpeaking) return;

      this.silencePressureTimerId = null;
      this.emit('silencePressure');

      logger.debug({ silencePressureMs: this.silencePressureMs }, 'TurnTaking: silence pressure fired');
    }, this.silencePressureMs);
  }

  private clearSilencePressure(): void {
    if (this.silencePressureTimerId !== null) {
      clearTimeout(this.silencePressureTimerId);
      this.silencePressureTimerId = null;
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────

  private clearAllTimers(): void {
    this.clearSilenceTimers();
    this.clearSilencePressure();
    this.clearFinalTranscriptTimer();
  }
}
