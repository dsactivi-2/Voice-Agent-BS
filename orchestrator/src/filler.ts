import { logger } from './utils/logger.js';
import type { AgentConfig, CallSession, FillerType } from './types.js';

/**
 * Patterns that indicate an affirmation from the user.
 * Covers both Bosnian/Serbian and common short responses.
 */
const AFFIRMATION_PATTERNS = /^(da|da da|dobro|ok|okej|aha|mhm|naravno|svakako|jeste|jest|tačno|tacno|važi|vazi|uredu|u redu|razumijem|slažem se|slazem se|može|moze|super|odlično|odlicno|ja|yes|yeah|sure|right|exactly)$/i;

/**
 * Determines which filler type (if any) should be played before the bot's
 * response. Fillers create a more natural conversational experience by
 * filling the silence while the LLM generates a response.
 *
 * Returns null when no filler should be played — this happens when the
 * response is expected to be fast (mini LLM with short input).
 *
 * @param session    - The current call session
 * @param transcript - The user's latest transcript
 * @returns The filler type to play, or null if no filler is needed
 */
export function selectFiller(session: CallSession, transcript: string): FillerType | null {
  const trimmed = transcript.trim();

  // No filler for empty transcripts
  if (trimmed.length === 0) {
    return null;
  }

  // Mini LLM mode with short input — response will be fast, no filler needed
  if (session.llmMode === 'mini' && trimmed.length <= 30) {
    logger.trace(
      { llmMode: session.llmMode, transcriptLength: trimmed.length },
      'Filler skipped: mini LLM with short input',
    );
    return null;
  }

  // Detect question — user asked something that requires thinking
  if (trimmed.endsWith('?')) {
    logger.trace({ transcript: trimmed }, 'Filler: question detected → thinking');
    return 'thinking';
  }

  // Detect affirmation — user agreed/acknowledged
  if (AFFIRMATION_PATTERNS.test(trimmed)) {
    logger.trace({ transcript: trimmed }, 'Filler: affirmation detected → affirm');
    return 'affirm';
  }

  // Default — acknowledge the user's input
  logger.trace({ transcript: trimmed }, 'Filler: default → acknowledge');
  return 'acknowledge';
}

/**
 * Selects a random filler phrase from the agent's filler library for the
 * given filler type.
 *
 * @param agent      - The agent configuration containing the filler library
 * @param fillerType - The type of filler to select
 * @returns A random phrase string from the matching category
 * @throws If the filler library does not contain the requested type
 */
export function getFillerPhrase(agent: AgentConfig, fillerType: FillerType): string {
  const phrases = agent.fillerLibrary[fillerType];

  if (!phrases || phrases.length === 0) {
    logger.error({ fillerType }, 'Filler library has no phrases for the requested type');
    throw new Error(`No filler phrases available for type: ${fillerType}`);
  }

  const index = Math.floor(Math.random() * phrases.length);
  const phrase = phrases[index]!;

  logger.trace({ fillerType, phrase }, 'Filler phrase selected');

  return phrase;
}
