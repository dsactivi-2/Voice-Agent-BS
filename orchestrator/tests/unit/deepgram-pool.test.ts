import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger before importing the module under test
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

// Mock config with test values
vi.mock('../../src/config.js', () => ({
  config: {
    VAD_ENDPOINTING_MS: 300,
    DEEPGRAM_API_KEY: 'test-deepgram-key',
  },
}));

// Create a factory for mock DeepgramASRClient instances
function createMockClient(connected = true) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    sendAudio: vi.fn(),
    isConnected: vi.fn().mockReturnValue(connected),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    emit: vi.fn(),
  };
}

// Track all created mock clients
let mockClients: ReturnType<typeof createMockClient>[] = [];

vi.mock('../../src/deepgram/client.js', () => {
  // Must use a regular function (not arrow) so it can be called with `new`
  function MockDeepgramASRClient() {
    const client = createMockClient();
    mockClients.push(client);
    return client;
  }

  return {
    DeepgramASRClient: MockDeepgramASRClient,
  };
});

describe('DeepgramConnectionPool', () => {
  let DeepgramConnectionPool: typeof import('../../src/deepgram/connection-pool.js').DeepgramConnectionPool;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockClients = [];

    const mod = await import('../../src/deepgram/connection-pool.js');
    DeepgramConnectionPool = mod.DeepgramConnectionPool;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquire returns a connected client', async () => {
    const pool = new DeepgramConnectionPool(3, 'test-api-key');
    const client = await pool.acquire('bs');

    expect(client).toBeDefined();
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(pool.inUseCount).toBe(1);
    expect(pool.availableCount).toBe(0);

    await pool.closeAll();
  });

  it('release returns client to the available pool', async () => {
    const pool = new DeepgramConnectionPool(3, 'test-api-key');
    const client = await pool.acquire('bs');

    expect(pool.inUseCount).toBe(1);
    expect(pool.availableCount).toBe(0);

    pool.release(client);

    expect(pool.inUseCount).toBe(0);
    expect(pool.availableCount).toBe(1);

    await pool.closeAll();
  });

  it('acquire after release reuses the same client for matching language', async () => {
    const pool = new DeepgramConnectionPool(3, 'test-api-key');
    const client1 = await pool.acquire('bs');

    pool.release(client1);
    expect(pool.availableCount).toBe(1);

    const client2 = await pool.acquire('bs');

    // Should reuse the released client, not create a new one
    expect(client2).toBe(client1);
    expect(pool.inUseCount).toBe(1);
    // Only one DeepgramASRClient should have been instantiated
    expect(mockClients).toHaveLength(1);

    await pool.closeAll();
  });

  it('acquire creates a new client when language does not match available', async () => {
    const pool = new DeepgramConnectionPool(3, 'test-api-key');

    // Acquire and release a 'bs' client
    const bsClient = await pool.acquire('bs');
    pool.release(bsClient);
    expect(pool.availableCount).toBe(1);

    // Acquire an 'sr' client -- should create new, not reuse the 'bs' one
    const srClient = await pool.acquire('sr');

    expect(srClient).not.toBe(bsClient);
    expect(mockClients).toHaveLength(2);
    // The 'bs' client is still in the available pool
    expect(pool.availableCount).toBe(1);
    expect(pool.inUseCount).toBe(1);

    await pool.closeAll();
  });

  it('closeAll closes all available and in-use connections', async () => {
    const pool = new DeepgramConnectionPool(5, 'test-api-key');

    const client1 = await pool.acquire('bs');
    const client2 = await pool.acquire('sr');
    const client3 = await pool.acquire('bs');

    // Release one back to available
    pool.release(client1);
    expect(pool.availableCount).toBe(1);
    expect(pool.inUseCount).toBe(2);

    await pool.closeAll();

    // All clients should have had close() called
    expect(client1.close).toHaveBeenCalled();
    expect(client2.close).toHaveBeenCalled();
    expect(client3.close).toHaveBeenCalled();
    expect(pool.availableCount).toBe(0);
    expect(pool.inUseCount).toBe(0);
  });

  it('creates new connection when pool is exhausted (all in use)', async () => {
    // Pool size of 2
    const pool = new DeepgramConnectionPool(2, 'test-api-key');

    const client1 = await pool.acquire('bs');
    const client2 = await pool.acquire('bs');

    // Pool is full (2 in use, 0 available)
    expect(pool.inUseCount).toBe(2);

    // Acquiring a third should still succeed by creating a new connection
    const client3 = await pool.acquire('bs');
    expect(client3).toBeDefined();
    expect(pool.inUseCount).toBe(3);
    expect(mockClients).toHaveLength(3);

    // Release all -- only poolSize (2) should be kept, third should be closed
    pool.release(client1);
    pool.release(client2);

    expect(pool.availableCount).toBe(2);

    // Third release: pool is full, so the client is closed instead
    pool.release(client3);
    expect(pool.availableCount).toBe(2);
    expect(client3.close).toHaveBeenCalled();

    await pool.closeAll();
  });

  it('discards stale connection and creates a new one on acquire', async () => {
    const pool = new DeepgramConnectionPool(3, 'test-api-key');

    const client1 = await pool.acquire('bs');

    // Release and then mark the client as disconnected
    pool.release(client1);
    client1.isConnected.mockReturnValue(false);

    // Acquire again -- should detect stale connection and create new
    const client2 = await pool.acquire('bs');

    expect(client2).not.toBe(client1);
    expect(mockClients).toHaveLength(2);

    await pool.closeAll();
  });

  it('throws error when acquiring from a closed pool', async () => {
    const pool = new DeepgramConnectionPool(3, 'test-api-key');
    await pool.closeAll();

    await expect(pool.acquire('bs')).rejects.toThrow('DeepgramConnectionPool is closed');
  });

  it('closes released client when pool is already shut down', async () => {
    const pool = new DeepgramConnectionPool(3, 'test-api-key');
    const client = await pool.acquire('bs');

    await pool.closeAll();

    // Release after closeAll -- should close the client, not add to pool
    pool.release(client);
    // close is called both during closeAll and during release
    expect(client.close).toHaveBeenCalled();
    expect(pool.availableCount).toBe(0);
  });

  it('totalCount reflects both available and in-use connections', async () => {
    const pool = new DeepgramConnectionPool(5, 'test-api-key');

    const client1 = await pool.acquire('bs');
    const client2 = await pool.acquire('sr');
    expect(pool.totalCount).toBe(2);

    pool.release(client1);
    expect(pool.totalCount).toBe(2); // 1 available + 1 in use

    pool.release(client2);
    expect(pool.totalCount).toBe(2); // 2 available + 0 in use

    await pool.closeAll();
  });
});
