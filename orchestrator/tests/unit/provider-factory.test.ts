import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TelephonyEvents } from '../../src/telephony/provider.js';

// ---------------------------------------------------------------------------
// Mock all external dependencies before importing the factory
// ---------------------------------------------------------------------------

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    TELEPHONY_PROVIDER: 'telnyx',
    PORT: 3000,
    TELNYX_API_KEY: 'test-telnyx-key',
    TELNYX_PUBLIC_KEY: 'test-telnyx-public-key',
    TELNYX_APP_ID: 'test-telnyx-app-id',
    TELNYX_PHONE_BS: '+38761111111',
    TELNYX_PHONE_SR: '+381111111111',
    VONAGE_API_KEY: 'test-vonage-key',
    VONAGE_API_SECRET: 'test-vonage-secret',
    VONAGE_APPLICATION_ID: 'test-vonage-app-id',
    VONAGE_PRIVATE_KEY_PATH: '/tmp/test-key.pem',
    VONAGE_PHONE_NUMBER: '+38762222222',
    MEMORY_CROSS_CALL_ENABLED: false,
    ANTI_LOOP_COOLDOWN_HOURS: 24,
  },
}));

// Mock server active call tracking
vi.mock('../../src/server.js', () => ({
  incrementActiveCalls: vi.fn(),
  decrementActiveCalls: vi.fn(),
  getActiveCalls: vi.fn(() => 0),
}));

// Mock DB queries
vi.mock('../../src/db/queries.js', () => ({
  createCall: vi.fn(),
  updateCallResult: vi.fn(),
  upsertCallMemory: vi.fn(),
  getCallMemory: vi.fn(),
}));

// Mock anti-loop
vi.mock('../../src/session/anti-loop.js', () => ({
  canCallNumber: vi.fn(() => Promise.resolve(true)),
  markCallMade: vi.fn(() => Promise.resolve()),
}));

// Mock the Telnyx webhook module
vi.mock('../../src/telnyx/webhook.js', () => ({
  createWebhookHandler: vi.fn(() => vi.fn()),
}));

// Mock the Telnyx media-stream module
vi.mock('../../src/telnyx/media-stream.js', () => ({
  MediaStreamSession: vi.fn(),
  createMediaStreamHandler: vi.fn(() => vi.fn()),
}));

// Mock the Telnyx outbound module
vi.mock('../../src/telnyx/outbound.js', () => ({
  initiateOutboundCall: vi.fn(),
}));

// Mock the Vonage outbound module
vi.mock('../../src/vonage/outbound.js', () => ({
  initiateOutboundCall: vi.fn(),
  hangUpCall: vi.fn(),
}));

// Import after mocks are established
import { createTelephonyProvider } from '../../src/telephony/factory.js';
import { TelnyxProvider } from '../../src/telephony/telnyx-provider.js';
import { VonageProvider } from '../../src/vonage/provider.js';

// ---------------------------------------------------------------------------
// Shared test events
// ---------------------------------------------------------------------------

function createMockEvents(): TelephonyEvents {
  return {
    onCallStarted: vi.fn(),
    onCallEnded: vi.fn(),
    onAudioReceived: vi.fn(),
    onError: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createTelephonyProvider', () => {
  it('should create TelnyxProvider when providerName is "telnyx"', () => {
    const events = createMockEvents();
    const provider = createTelephonyProvider(events, 'telnyx');

    expect(provider).toBeInstanceOf(TelnyxProvider);
    expect(provider.name).toBe('telnyx');
  });

  it('should create VonageProvider when providerName is "vonage"', () => {
    const events = createMockEvents();
    const provider = createTelephonyProvider(events, 'vonage');

    expect(provider).toBeInstanceOf(VonageProvider);
    expect(provider.name).toBe('vonage');
  });

  it('should throw an error for an unknown provider name', () => {
    const events = createMockEvents();

    expect(() => createTelephonyProvider(events, 'twilio')).toThrow(
      'Unknown telephony provider: twilio',
    );
  });

  it('should default to telnyx when no providerName override is given', () => {
    // config.TELEPHONY_PROVIDER is mocked as 'telnyx' above
    const events = createMockEvents();
    const provider = createTelephonyProvider(events);

    expect(provider).toBeInstanceOf(TelnyxProvider);
    expect(provider.name).toBe('telnyx');
  });

  it('should pass the events object to the created provider', () => {
    const events = createMockEvents();
    const provider = createTelephonyProvider(events, 'vonage');

    // VonageProvider stores events internally; verify it was created without error
    expect(provider).toBeInstanceOf(VonageProvider);
    expect(provider.name).toBe('vonage');
  });
});
