import { logger } from '../utils/logger.js';
import type { CallSession, Phase, Language, LLMMode, ABGroup, StructuredMemory } from '../types.js';

/** Maximum call duration in milliseconds (9 minutes). */
const MAX_CALL_DURATION_MS = 9 * 60 * 1000;

/** Bosnian/Serbian keywords that indicate the user is raising an objection. */
const OBJECTION_KEYWORDS = [
  'ne zanima',
  'ne zelim',
  'ne mogu',
  'nemam vremena',
  'preskupo',
  'skupo',
  'vec imam',
  'ne treba',
  'nemoj',
  'prestani',
  'ne hvala',
  'ne trebam',
  'nema smisla',
  'ne vrijedi',
  'ne vredi',
  'ne isplati',
  'nemam novca',
  'nemam para',
  'nisam zainteresovan',
  'nisam zainteresirana',
  'otkazi',
  'prekini',
  'ne kontaktiraj',
  'ne zovi',
  'previse',
  'nema potrebe',
  'problem',
  'ali',
  'medjutim',
  'ipak',
] as const;

/** Keywords/phrases that indicate the user agrees or confirms. */
const AGREEMENT_KEYWORDS = [
  'da, moze',
  'slazem se',
  'prihvatam',
  'dogovoreno',
  'u redu',
  'naravno',
  'svakako',
  'moze',
  'hajde',
  'pristajem',
  'zelim',
  'hocu',
  'zakaži',
  'zakazi',
  'potpisi',
  'potpisi',
  'dajem saglasnost',
  'pozitivno',
  'potvrditi',
  'potvrdjujem',
  'važi',
  'vazi',
  'da da',
  'da naravno',
  'bas tako',
  'super',
  'odlicno',
  'odlično',
  'sjajno',
  'savrseno',
  'savršeno',
] as const;

export interface CreateCallSessionParams {
  callId: string;
  phoneNumber: string;
  language: Language;
  campaignId: string;
  abGroup: ABGroup;
  initialLLMMode: LLMMode;
}

/**
 * Creates a new CallSession with sensible defaults.
 *
 * @param params - Initial call parameters
 * @returns A fresh CallSession ready for use in the orchestrator
 */
export function createCallSession(params: CreateCallSessionParams): CallSession {
  const session: CallSession = {
    callId: params.callId,
    phoneNumber: params.phoneNumber,
    language: params.language,
    llmMode: params.initialLLMMode,
    interestScores: [],
    complexityScore: 0,
    phase: 'hook',
    campaignId: params.campaignId,
    abGroup: params.abGroup,
    startedAt: new Date(),
    turnCount: 0,
    conversationSummary: '',
    structuredMemory: {
      objections: [],
      tone: 'neutral',
      microCommitment: false,
    },
    callerSpokeRecently: false,
  };

  logger.debug(
    { callId: session.callId, language: session.language, abGroup: session.abGroup },
    'Call session created',
  );

  return session;
}

/**
 * Determines the next conversation phase based on the current session state
 * and the latest LLM response scores.
 *
 * State machine transitions:
 *   hook      -> qualify    (interest > 0.3)
 *   qualify   -> pitch      (interest > 0.5)
 *   pitch     -> objection  (objection detected)
 *   pitch     -> close      (interest > 0.72)
 *   objection -> close      (interest > 0.72)
 *   objection -> pitch      (otherwise)
 *   close     -> confirm    (agreement detected)
 *   close     -> objection  (objection detected)
 *   confirm   -> confirm    (stays)
 *
 * @param session     - The current call session
 * @param llmResponse - Object containing at minimum interest_score and reply_text
 * @returns The next phase to transition to
 */
export function getNextPhase(
  session: CallSession,
  llmResponse: { interest_score: number; reply_text: string },
): Phase {
  const { phase } = session;
  const interest = llmResponse.interest_score;
  const responseText = llmResponse.reply_text;
  const objectionDetected = hasObjection(responseText);
  const agreementDetected = hasAgreement(responseText);

  let nextPhase: Phase = phase;

  switch (phase) {
    case 'hook': {
      if (interest > 0.3) {
        nextPhase = 'qualify';
      }
      break;
    }

    case 'qualify': {
      if (interest > 0.5) {
        nextPhase = 'pitch';
      }
      break;
    }

    case 'pitch': {
      if (objectionDetected) {
        nextPhase = 'objection';
      } else if (interest > 0.72) {
        nextPhase = 'close';
      }
      break;
    }

    case 'objection': {
      if (interest > 0.72) {
        nextPhase = 'close';
      } else {
        nextPhase = 'pitch';
      }
      break;
    }

    case 'close': {
      if (agreementDetected) {
        nextPhase = 'confirm';
      } else if (objectionDetected) {
        nextPhase = 'objection';
      }
      break;
    }

    case 'confirm': {
      // Terminal phase -- stays in confirm
      nextPhase = 'confirm';
      break;
    }
  }

  if (nextPhase !== phase) {
    logger.info(
      {
        callId: session.callId,
        from: phase,
        to: nextPhase,
        interest,
        objectionDetected,
        agreementDetected,
      },
      'Phase transition',
    );
  }

  return nextPhase;
}

/**
 * Checks whether the call has exceeded the maximum allowed duration (9 minutes).
 * Returns true when the call should be forced into the close phase.
 *
 * @param session - The current call session
 * @returns true if the call duration exceeds 9 minutes
 */
export function checkCallDuration(session: CallSession): boolean {
  const elapsed = Date.now() - session.startedAt.getTime();
  const exceeded = elapsed > MAX_CALL_DURATION_MS;

  if (exceeded) {
    logger.warn(
      { callId: session.callId, elapsedMs: elapsed, maxMs: MAX_CALL_DURATION_MS },
      'Call duration exceeded maximum — forcing close',
    );
  }

  return exceeded;
}

/**
 * Detects whether the response text contains objection keywords.
 * Uses case-insensitive matching against a predefined list of
 * Bosnian/Serbian objection phrases.
 *
 * @param response - The text to check for objections
 * @returns true if an objection keyword is found
 */
export function hasObjection(response: string): boolean {
  const lower = response.toLowerCase();
  return OBJECTION_KEYWORDS.some((keyword) => lower.includes(keyword));
}

/**
 * Detects whether the response text contains agreement keywords.
 * Uses case-insensitive matching against a predefined list of
 * Bosnian/Serbian agreement phrases.
 *
 * @param response - The text to check for agreement
 * @returns true if an agreement keyword is found
 */
export function hasAgreement(response: string): boolean {
  const lower = response.toLowerCase();
  return AGREEMENT_KEYWORDS.some((keyword) => lower.includes(keyword));
}

export { MAX_CALL_DURATION_MS, OBJECTION_KEYWORDS, AGREEMENT_KEYWORDS };
