import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { TelnyxProvider } from './telnyx-provider.js';
import { VonageProvider } from '../vonage/provider.js';
import type { TelephonyProvider, TelephonyEvents } from './provider.js';

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Creates a telephony provider instance based on the configured provider name.
 *
 * Reads TELEPHONY_PROVIDER from the application configuration (defaults to 'telnyx')
 * and instantiates the corresponding provider class with the given event callbacks.
 *
 * @param events       - Event callbacks that the provider will invoke during calls
 * @param providerName - Optional override; defaults to config.TELEPHONY_PROVIDER
 * @returns A fully initialised TelephonyProvider instance
 * @throws {Error} When the provider name is unknown
 */
export function createTelephonyProvider(
  events: TelephonyEvents,
  providerName?: string,
): TelephonyProvider {
  const name = providerName ?? config.TELEPHONY_PROVIDER;

  logger.info({ provider: name }, 'Creating telephony provider');

  switch (name) {
    case 'telnyx':
      return new TelnyxProvider(events);

    case 'vonage':
      return new VonageProvider(events);

    default:
      throw new Error(`Unknown telephony provider: ${name}`);
  }
}

/**
 * Returns the currently configured telephony provider name.
 * Useful for feature-flagging or conditional logic based on the active provider.
 */
export function getProviderName(): string {
  return config.TELEPHONY_PROVIDER;
}
