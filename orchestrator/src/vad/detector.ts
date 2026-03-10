import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { AdaptiveVADFilter } from './adaptive-filter.js';

type VADState = 'idle' | 'speaking' | 'grace_period';

export interface VADDetectorOptions {
  /** RMS energy threshold to distinguish speech from silence (0..1). */
  energyThreshold?: number;
  /** Minimum consecutive speech duration to confirm real speech (ms). */
  minSpeechDurationMs?: number;
  /** How long to wait after speech drops below threshold before declaring end (ms). */
  gracePeriodMs?: number;
  /** Sample rate of the incoming PCM audio (Hz). Default 16000. */
  sampleRate?: number;
}

export interface VADDetectorEvents {
  speechStart: [];
  speechEnd: [durationMs: number];
  silence: [];
}

/**
 * Calculates the Root Mean Square energy for a PCM 16-bit LE audio buffer.
 * Returns a normalised value in the range 0..1.
 */
function calculateRMS(buffer: Buffer): number {
  let sum = 0;
  const samples = buffer.length / 2; // 16-bit = 2 bytes per sample

  if (samples === 0) return 0;

  for (let i = 0; i < buffer.length; i += 2) {
    const sample = buffer.readInt16LE(i) / 32768; // normalise to -1..1
    sum += sample * sample;
  }

  return Math.sqrt(sum / samples);
}

/**
 * Energy-based Voice Activity Detector for PCM 16-bit audio.
 *
 * Tracks three states:
 *  - idle:         No speech detected
 *  - speaking:     Active speech in progress
 *  - grace_period: Speech stopped, waiting to see if it resumes
 *
 * Emits:
 *  - 'speechStart' when confirmed speech begins (survived min duration filter)
 *  - 'speechEnd'   when speech truly ends after the grace period
 *  - 'silence'     on each silent chunk while idle
 *
 * NEW: Integrated with AdaptiveVADFilter for codec-aware, bot-aware speech detection.
 */
export class VADDetector extends EventEmitter<VADDetectorEvents> {
  private readonly energyThreshold: number;
  private readonly minSpeechDurationMs: number;
  private readonly gracePeriodMs: number;
  private readonly sampleRate: number;

  private state: VADState = 'idle';

  /** Timestamp when energy first exceeded the threshold in the current run. */
  private speechStartTimestamp: number = 0;

  /** Timestamp when the confirmed speechStart event was emitted. */
  private confirmedSpeechStartTimestamp: number = 0;

  /** Whether we already emitted speechStart for the current speech run. */
  private speechStartEmitted: boolean = false;

  /** Timer ID for the grace period timeout. */
  private graceTimerId: ReturnType<typeof setTimeout> | null = null;

  private destroyed: boolean = false;

  // NEW: Adaptive filter for codec-aware, bot-aware VAD
  private readonly adaptiveFilter: AdaptiveVADFilter;
  private botSpeakingFlag: boolean = false;

  constructor(options: VADDetectorOptions = {}) {
    super();

    this.energyThreshold = options.energyThreshold ?? 0.01;
    this.minSpeechDurationMs = options.minSpeechDurationMs ?? config.VAD_BARGE_IN_MIN_MS;
    this.gracePeriodMs = options.gracePeriodMs ?? config.VAD_GRACE_MS;
    this.sampleRate = options.sampleRate ?? 16000;

    // NEW: Initialize adaptive filter
    this.adaptiveFilter = new AdaptiveVADFilter();

    logger.debug(
      {
        energyThreshold: this.energyThreshold,
        minSpeechDurationMs: this.minSpeechDurationMs,
        gracePeriodMs: this.gracePeriodMs,
        sampleRate: this.sampleRate,
      },
      'VADDetector initialised with AdaptiveVADFilter',
    );
  }

  /**
   * Feed a PCM 16-bit LE audio chunk into the detector.
   * This is the main entry point called on every audio frame from the ring buffer.
   * 
   * NEW: Uses AdaptiveVADFilter for codec-aware threshold adaptation.
   */
  processAudio(chunk: Buffer): void {
    if (this.destroyed) return;

    // NEW: Analyze with adaptive filter
    const analysis = this.adaptiveFilter.processAudioFrame(chunk);
    const isSpeech = analysis.isSpeech;

    // Log codec quality when detected
    if (analysis.codecQuality !== 'unknown') {
      logger.debug(
        {
          codecQuality: analysis.codecQuality,
          rms: Number(analysis.rms.toFixed(3)),
          threshold: Number(analysis.threshold.toFixed(3)),
          botSpeaking: this.botSpeakingFlag,
        },
        'VAD: audio analysis',
      );
    }

    const now = Date.now();

    switch (this.state) {
      case 'idle':
        this.handleIdle(isSpeech, now);
        break;

      case 'speaking':
        this.handleSpeaking(isSpeech, now);
        break;

      case 'grace_period':
        this.handleGracePeriod(isSpeech, now);
        break;
    }
  }

  /**
   * NEW: Signal to the VAD that bot is actively speaking.
   * This prevents false positives on echo during TTS.
   */
  setBotSpeaking(isActive: boolean): void {
    if (this.botSpeakingFlag !== isActive) {
      this.botSpeakingFlag = isActive;
      this.adaptiveFilter.setBotSpeaking(isActive);
      logger.debug({ botSpeaking: isActive }, 'VAD: bot speech flag changed');
    }
  }

  /**
   * Resets the detector to its initial idle state, clearing all timers.
   */
  reset(): void {
    this.clearGraceTimer();
    this.state = 'idle';
    this.speechStartTimestamp = 0;
    this.confirmedSpeechStartTimestamp = 0;
    this.speechStartEmitted = false;
    this.botSpeakingFlag = false;
    this.adaptiveFilter.reset();

    logger.debug('VADDetector reset');
  }

  /**
   * Permanently destroys the detector, cleaning up all resources.
   * No further events will be emitted after this call.
   */
  destroy(): void {
    this.destroyed = true;
    this.clearGraceTimer();
    this.removeAllListeners();

    logger.debug('VADDetector destroyed');
  }

  /** Returns the current VAD state — useful for diagnostics. */
  getState(): VADState {
    return this.state;
  }

  // ── State Handlers ──────────────────────────────────────────────

  private handleIdle(isSpeech: boolean, now: number): void {
    if (isSpeech) {
      // Energy exceeded threshold — start tracking potential speech
      this.speechStartTimestamp = now;
      this.state = 'speaking';

      logger.trace({ rmsAboveThreshold: true }, 'VAD: possible speech detected, entering speaking state');
    } else {
      this.emit('silence');
    }
  }

  private handleSpeaking(isSpeech: boolean, now: number): void {
    if (isSpeech) {
      // Still hearing speech — check if we passed the minimum duration
      const elapsed = now - this.speechStartTimestamp;

      if (!this.speechStartEmitted && elapsed >= this.minSpeechDurationMs) {
        this.speechStartEmitted = true;
        this.confirmedSpeechStartTimestamp = now;
        this.emit('speechStart');

        logger.debug({ elapsedMs: elapsed }, 'VAD: speechStart confirmed');
      }
    } else {
      // Energy dropped below threshold
      if (this.speechStartEmitted) {
        // Confirmed speech was in progress — enter grace period
        this.enterGracePeriod();
      } else {
        // Short noise burst (< minSpeechDurationMs) — treat as background noise
        const elapsed = now - this.speechStartTimestamp;
        logger.trace({ elapsedMs: elapsed }, 'VAD: short noise ignored, returning to idle');

        this.state = 'idle';
        this.speechStartTimestamp = 0;
      }
    }
  }

  private handleGracePeriod(isSpeech: boolean, _now: number): void {
    if (isSpeech) {
      // Speech resumed within the grace window — cancel the timer and continue
      this.clearGraceTimer();
      this.state = 'speaking';

      logger.trace('VAD: speech resumed during grace period');
    }
    // If still silent, the grace timer will fire and handle the transition
  }

  // ── Grace Period Management ─────────────────────────────────────

  private enterGracePeriod(): void {
    this.state = 'grace_period';

    this.clearGraceTimer();

    this.graceTimerId = setTimeout(() => {
      if (this.destroyed) return;

      const durationMs = Date.now() - this.confirmedSpeechStartTimestamp;

      this.state = 'idle';
      this.speechStartTimestamp = 0;
      this.confirmedSpeechStartTimestamp = 0;
      this.speechStartEmitted = false;
      this.graceTimerId = null;

      this.emit('speechEnd', durationMs);

      logger.debug({ durationMs }, 'VAD: speechEnd — grace period expired');
    }, this.gracePeriodMs);
  }

  private clearGraceTimer(): void {
    if (this.graceTimerId !== null) {
      clearTimeout(this.graceTimerId);
      this.graceTimerId = null;
    }
  }
}

export { calculateRMS };
