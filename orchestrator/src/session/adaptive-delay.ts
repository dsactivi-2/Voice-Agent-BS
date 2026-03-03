import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Calculates an adaptive artificial delay to make bot responses sound more
 * natural. Humans do not respond instantly — a short pause before replying
 * feels more conversational and less robotic.
 *
 * The delay depends on transcript length (a proxy for question complexity):
 *  - Short answers (<10 chars):  min 200ms pause
 *  - Medium answers (<30 chars): min 300ms pause
 *  - Complex answers (>=30 chars): no artificial delay needed — processing
 *    latency alone is sufficient to sound natural
 *
 * When llmMode is 'mini' and the transcript is short (<60 chars), the
 * maximum delay is capped at 200ms — mini responses arrive quickly and a
 * large artificial pause causes a noticeable silence between turns.
 *
 * The function only returns the ADDITIONAL wait time. If the actual
 * processing was already slow enough, no extra delay is added.
 *
 * @param transcript       - The user's transcript text
 * @param actualLatencyMs  - How many ms the real processing already took
 * @param llmMode          - Current LLM mode ('mini' | 'full'), optional
 * @returns                - Additional ms to wait before speaking (0 = no delay)
 */
export function calculateAdaptiveDelay(transcript: string, actualLatencyMs: number, llmMode?: string): number {
  const length = transcript.length;

  // For mini LLM mode with short input, cap the maximum delay at 200ms.
  // Mini responses arrive quickly and a larger pause creates noticeable silence.
  const effectiveMaxMs = (llmMode === 'mini' && length < 60)
    ? 200
    : config.ADAPTIVE_DELAY_MAX_MS;

  let targetDelayMs: number;

  if (length < 10) {
    // Short utterance — quick acknowledgement expected but not instant
    targetDelayMs = config.ADAPTIVE_DELAY_MIN_MS;
  } else if (length < 30) {
    // Medium utterance — slightly longer thinking pause
    targetDelayMs = Math.min(
      config.ADAPTIVE_DELAY_MIN_MS + 100,
      effectiveMaxMs,
    );
  } else {
    // Complex utterance — the LLM processing time already provides
    // a natural delay, so no artificial wait is needed
    return 0;
  }

  // Clamp to the effective maximum
  targetDelayMs = Math.min(targetDelayMs, effectiveMaxMs);

  // Only add extra delay if processing was faster than the target
  const additionalDelay = Math.max(0, targetDelayMs - actualLatencyMs);

  logger.trace(
    {
      transcriptLength: length,
      targetDelayMs,
      actualLatencyMs,
      additionalDelay,
    },
    'Adaptive delay calculated',
  );

  return additionalDelay;
}
