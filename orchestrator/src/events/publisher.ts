import { redis } from '../cache/redis-client.js';
import { logger } from '../utils/logger.js';
import type { Phase, CallResult, Language, LLMMode, ABGroup } from '../types.js';

export const CALL_EVENTS_CHANNEL = 'call-events';

export interface CallStartedEvent {
  type: 'call.started';
  callId: string;
  phoneNumber: string;
  language: Language;
  campaignId: string;
  abGroup: ABGroup;
  llmMode: LLMMode;
  ts: number;
}

export interface CallTurnCompletedEvent {
  type: 'call.turn_completed';
  callId: string;
  turn: number;
  phase: Phase;
  ts: number;
}

export interface CallPhaseChangedEvent {
  type: 'call.phase_changed';
  callId: string;
  from: Phase;
  to: Phase;
  ts: number;
}

export interface CallLlmSwitchedEvent {
  type: 'call.llm_switched';
  callId: string;
  from: LLMMode;
  to: LLMMode;
  ts: number;
}

export interface CallEndedEvent {
  type: 'call.ended';
  callId: string;
  result: CallResult;
  ts: number;
}

export type CallEvent =
  | CallStartedEvent
  | CallTurnCompletedEvent
  | CallPhaseChangedEvent
  | CallLlmSwitchedEvent
  | CallEndedEvent;

/**
 * Publishes a call event to the Redis call-events channel.
 * Fire-and-forget — failures are logged but never throw to the caller.
 */
export async function publishCallEvent(event: CallEvent): Promise<void> {
  try {
    await redis.publish(CALL_EVENTS_CHANNEL, JSON.stringify(event));
  } catch (err) {
    logger.warn({ err, eventType: event.type }, 'Failed to publish call event to Redis — continuing');
  }
}
