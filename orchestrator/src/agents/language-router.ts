import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { agentBS } from './agent-bs.js';
import { agentSR } from './agent-sr.js';
import type { AgentConfig, Language } from '../types.js';

/**
 * Normalises a phone number to a consistent format for comparison.
 * Strips spaces, dashes, and parentheses but keeps the leading '+'.
 */
function normaliseNumber(phone: string): string {
  return phone.replace(/[\s\-()]/g, '');
}

/**
 * Internal routing table mapping normalised phone numbers to their
 * corresponding agent configurations.
 *
 * Covers both Telnyx numbers (TELNYX_PHONE_BS / TELNYX_PHONE_SR) and
 * the single Vonage DE number (VONAGE_PHONE_NUMBER → BS agent / Goran).
 * Entries whose config value is undefined are skipped so that an empty
 * string is never registered as a valid route.
 */
function buildRoutingTable(): Map<string, AgentConfig> {
  const table = new Map<string, AgentConfig>();

  // Telnyx routes
  if (config.TELNYX_PHONE_BS) {
    table.set(normaliseNumber(config.TELNYX_PHONE_BS), agentBS);
  }
  if (config.TELNYX_PHONE_SR) {
    table.set(normaliseNumber(config.TELNYX_PHONE_SR), agentSR);
  }

  // Vonage DE number → Bosnian agent (Goran)
  if (config.VONAGE_PHONE_NUMBER) {
    table.set(normaliseNumber(config.VONAGE_PHONE_NUMBER), agentBS);
  }

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

/**
 * Determines the agent config for a Vonage inbound call.
 * Uses VONAGE_PHONE_NUMBER for routing; defaults to agentBS.
 *
 * @param calledNumber - The Vonage number that received the call (E.164 format)
 * @returns AgentConfig for the matched language
 */
export function routeVonageCall(calledNumber: string): AgentConfig {
  const agent = config.VONAGE_DEFAULT_LANGUAGE === 'sr-RS' ? agentSR : agentBS;

  logger.info(
    { calledNumber, language: agent.language },
    'Vonage call routed by VONAGE_DEFAULT_LANGUAGE',
  );

  return agent;
}

/**
 * Resolves an AgentConfig directly from a BCP-47 language tag.
 * Used for outbound calls where the language is explicitly specified in the API request.
 *
 * @param language - BCP-47 language tag ('bs-BA' or 'sr-RS')
 * @returns The matching AgentConfig
 */
export function routeByLanguage(language: Language): AgentConfig {
  const agent = language === 'sr-RS' ? agentSR : agentBS;

  logger.info(
    { language, agent: agent.ttsVoice },
    'Agent routed by explicit language',
  );

  return agent;
}
