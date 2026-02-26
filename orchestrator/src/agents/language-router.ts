import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { agentBS } from './agent-bs.js';
import { agentSR } from './agent-sr.js';
import type { AgentConfig } from '../types.js';

/**
 * Normalises a phone number to a consistent format for comparison.
 * Strips spaces, dashes, and parentheses but keeps the leading '+'.
 */
function normaliseNumber(phone: string): string {
  return phone.replace(/[\s\-()]/g, '');
}

/**
 * Internal routing table mapping normalised Telnyx phone numbers
 * to their corresponding agent configurations.
 */
function buildRoutingTable(): Map<string, AgentConfig> {
  const table = new Map<string, AgentConfig>();
  table.set(normaliseNumber(config.TELNYX_PHONE_BS ?? ''), agentBS);
  table.set(normaliseNumber(config.TELNYX_PHONE_SR ?? ''), agentSR);
  return table;
}

/**
 * Determines the agent configuration based on the Telnyx phone number
 * that received the call (the "called" or "to" number).
 *
 * @param calledNumber - The phone number that was called (E.164 format)
 * @returns The matching AgentConfig for the language/region
 * @throws {Error} When no agent is configured for the given phone number
 */
export function routeByPhoneNumber(calledNumber: string): AgentConfig {
  const normalised = normaliseNumber(calledNumber);
  const routingTable = buildRoutingTable();
  const agentConfig = routingTable.get(normalised);

  if (!agentConfig) {
    logger.error(
      { calledNumber, normalised, knownNumbers: Array.from(routingTable.keys()) },
      'No agent configured for called phone number',
    );
    throw new Error(`No agent configured for phone number: ${calledNumber}`);
  }

  logger.info(
    { calledNumber, language: agentConfig.language },
    'Language routed by phone number',
  );

  return agentConfig;
}
