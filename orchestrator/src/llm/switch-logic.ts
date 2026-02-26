import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { CallSession, ABGroup, Phase } from '../types.js';

const SWITCH_ELIGIBLE_PHASES: ReadonlySet<Phase> = new Set([
  'pitch',
  'objection',
  'close',
]);

const AB_GROUPS: readonly ABGroup[] = ['mini_only', 'mini_to_full', 'full_only'];

export function shouldSwitchToFull(session: CallSession): boolean {
  if (session.llmMode === 'full') {
    return false;
  }

  if (session.abGroup === 'mini_only') {
    return false;
  }

  if (session.abGroup === 'full_only') {
    logger.info(
      { callId: session.callId, abGroup: session.abGroup },
      'LLM switch triggered: full_only A/B group',
    );
    return true;
  }

  if (!SWITCH_ELIGIBLE_PHASES.has(session.phase)) {
    return false;
  }

  const recentScores = session.interestScores.slice(-3);
  const interestAvg =
    recentScores.length > 0
      ? recentScores.reduce((sum, s) => sum + s, 0) / recentScores.length
      : 0;

  const interestTriggered = interestAvg > config.LLM_SWITCH_INTEREST_THRESHOLD;
  const complexityTriggered =
    session.complexityScore > config.LLM_SWITCH_COMPLEXITY_THRESHOLD;

  if (interestTriggered || complexityTriggered) {
    logger.info(
      {
        callId: session.callId,
        phase: session.phase,
        interestAvg,
        complexityScore: session.complexityScore,
        interestTriggered,
        complexityTriggered,
      },
      'LLM switch triggered: score thresholds exceeded',
    );
    return true;
  }

  return false;
}

export function assignABGroup(
  phoneNumber: string,
  campaignId: string,
): ABGroup {
  const hash = createHash('sha256')
    .update(phoneNumber + campaignId)
    .digest();

  const firstByte = hash[0]!;
  const bucket = firstByte % 3;

  return AB_GROUPS[bucket]!;
}
