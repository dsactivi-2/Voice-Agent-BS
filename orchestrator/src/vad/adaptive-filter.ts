import { logger } from '../utils/logger.js';

export class AdaptiveVADFilter {
  private rmsThreshold: number = 0.08;
  private readonly rmsThresholdDefault: number = 0.08;
  private readonly rmsThresholdHighQuality: number = 0.05;
  private readonly rmsThresholdLowQuality: number = 0.12;
  private codecQualityHistory: number[] = [];
  private isHighQualityCodec: boolean = false;
  private botSpeechActive: boolean = false;
  private botSpeechEndTime: number = 0;
  private readonly botSpeechGracePeriodMs: number = 400;
  private rmsHistory: number[] = [];
  private readonly maxRmsHistoryLength: number = 5;
  private state: 'idle' | 'speaking' | 'grace' = 'idle';
  private speechStartTime: number = 0;
  private readonly minSpeechDurationMs: number = 100;

  constructor() {
    this.rmsThreshold = this.rmsThresholdDefault;
    logger.debug('AdaptiveVADFilter initialized');
  }

  processAudioFrame(audioBuffer: Buffer): {
    isSpeech: boolean;
    rms: number;
    threshold: number;
    isClean: boolean;
    codecQuality: 'high' | 'low' | 'unknown';
  } {
    const rms = this.calculateRMS(audioBuffer);
    const codecQuality = this.detectCodecQuality(audioBuffer);

    if (codecQuality === 'high') {
      this.rmsThreshold = this.rmsThresholdHighQuality;
    } else if (codecQuality === 'low') {
      this.rmsThreshold = this.rmsThresholdLowQuality;
    } else {
      this.rmsThreshold = this.rmsThresholdDefault;
    }

    const smoothedRMS = this.smoothRMS(rms);
    const isSpeech = smoothedRMS >= this.rmsThreshold;
    const isClean = this.isCleanAudio(audioBuffer);

    return { isSpeech, rms: smoothedRMS, threshold: this.rmsThreshold, isClean, codecQuality };
  }

  setBotSpeaking(speaking: boolean): void {
    this.botSpeechActive = speaking;
    if (!speaking) {
      this.botSpeechEndTime = Date.now();
    }
  }

  private isInBotSpeechGracePeriod(): boolean {
    if (this.botSpeechActive) return true;
    if (!this.botSpeechEndTime) return false;
    const elapsed = Date.now() - this.botSpeechEndTime;
    return elapsed < this.botSpeechGracePeriodMs;
  }

  updateVADState(frameData: { isSpeech: boolean; rms: number; isClean: boolean }): 'speechStart' | 'speaking' | 'speechEnd' | 'silence' {
    if (this.isInBotSpeechGracePeriod() && !frameData.isSpeech) {
      if (this.state !== 'idle') {
        this.state = 'idle';
        return 'silence';
      }
      return 'silence';
    }

    switch (this.state) {
      case 'idle':
        if (frameData.isSpeech && frameData.isClean) {
          this.speechStartTime = Date.now();
          this.state = 'speaking';
          return 'speechStart';
        }
        return 'silence';

      case 'speaking':
        if (!frameData.isSpeech) {
          this.state = 'grace';
          return 'speechEnd';
        }
        return 'speaking';

      case 'grace':
        if (frameData.isSpeech) {
          this.state = 'speaking';
          return 'speaking';
        }
        this.state = 'idle';
        return 'silence';
    }
  }

  private calculateRMS(buffer: Buffer): number {
    let sum = 0;
    const samples = buffer.length / 2;
    if (samples === 0) return 0;
    for (let i = 0; i < buffer.length; i += 2) {
      const sample = buffer.readInt16LE(i) / 32768;
      sum += sample * sample;
    }
    return Math.sqrt(sum / samples);
  }

  private smoothRMS(rms: number): number {
    this.rmsHistory.push(rms);
    if (this.rmsHistory.length > this.maxRmsHistoryLength) {
      this.rmsHistory.shift();
    }
    const sorted = [...this.rmsHistory].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length === 0) return rms;
    if (sorted.length === 1) return sorted[0]!;
    return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  }

  private detectCodecQuality(buffer: Buffer): 'high' | 'low' | 'unknown' {
    let zeroCrossings = 0;
    for (let i = 2; i < buffer.length; i += 2) {
      const prev = buffer.readInt16LE(i - 2);
      const curr = buffer.readInt16LE(i);
      if ((prev < 0 && curr >= 0) || (prev >= 0 && curr < 0)) {
        zeroCrossings++;
      }
    }
    const zcr = zeroCrossings / (buffer.length / 2 || 1);
    if (zcr > 0.3) {
      this.codecQualityHistory.push(0);
      return 'low';
    } else if (zcr < 0.15) {
      this.codecQualityHistory.push(1);
      return 'high';
    }
    return 'unknown';
  }

  private isCleanAudio(buffer: Buffer): boolean {
    const rms = this.calculateRMS(buffer);
    if (rms < 0.001 || rms > 0.9) return false;
    let mean = 0;
    for (let i = 0; i < buffer.length; i += 2) {
      mean += buffer.readInt16LE(i);
    }
    mean /= buffer.length / 2 || 1;
    return Math.abs(mean) < 1000;
  }

  reset(): void {
    this.state = 'idle';
    this.rmsHistory = [];
    this.codecQualityHistory = [];
    this.botSpeechActive = false;
    this.botSpeechEndTime = 0;
    this.rmsThreshold = this.rmsThresholdDefault;
  }

  getDebugInfo() {
    return {
      currentState: this.state,
      currentThreshold: this.rmsThreshold,
      botSpeechActive: this.botSpeechActive,
      inGracePeriod: this.isInBotSpeechGracePeriod(),
      codecQuality: this.isHighQualityCodec ? 'high' : 'low',
    };
  }
}
