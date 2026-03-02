import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock functions — available inside vi.mock() factories
// ---------------------------------------------------------------------------

const { mockConnect, mockClose, mockIsConnected, mockRemoveAllListeners, MockDeepgramASRClient } = vi.hoisted(() => {
  const mockConnect = vi.fn().mockResolvedValue(undefined);
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockIsConnected = vi.fn().mockReturnValue(true);
  const mockRemoveAllListeners = vi.fn();

  function MockDeepgramASRClient() {}
  MockDeepgramASRClient.prototype.connect = mockConnect;
  MockDeepgramASRClient.prototype.close = mockClose;
  MockDeepgramASRClient.prototype.isConnected = mockIsConnected;
  MockDeepgramASRClient.prototype.removeAllListeners = mockRemoveAllListeners;
  MockDeepgramASRClient.prototype.on = vi.fn();
  MockDeepgramASRClient.prototype.off = vi.fn();
  MockDeepgramASRClient.prototype.sendAudio = vi.fn();

  return { mockConnect, mockClose, mockIsConnected, mockRemoveAllListeners, MockDeepgramASRClient };
});

// ---------------------------------------------------------------------------
// Mocks — hoisted before any module imports
// ---------------------------------------------------------------------------

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock('../../src/deepgram/client.js', () => ({
  DeepgramASRClient: MockDeepgramASRClient,
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import { DeepgramConnectionPool } from '../../src/deepgram/connection-pool.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeepgramConnectionPool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Construction ──────────────────────────────────────────────────

  it('initialises with empty pool', () => {
    const pool = new DeepgramConnectionPool(3, 'test-key', 10);
    expect(pool.availableCount).toBe(0);
    expect(pool.inUseCount).toBe(0);
    expect(pool.totalCount).toBe(0);
  });

  // ── acquire — cold (no pool entries) ──────────────────────────────

  it('creates a new connection when pool is empty', async () => {
    const pool = new DeepgramConnectionPool(3, 'test-key', 10);
    const client = await pool.acquire('bs');

    expect(client).toBeDefined();
    expect(pool.inUseCount).toBe(1);
    expect(pool.availableCount).toBe(0);
  });

  // ── warmUp + acquire — hot path ───────────────────────────────────

  it('warmUp populates the available pool', async () => {
    const pool = new DeepgramConnectionPool(3, 'test-key', 10);
    await pool.warmUp('bs', 2);

    expect(pool.availableCount).toBe(2);
    expect(pool.inUseCount).toBe(0);
  });

  it('acquire returns a pre-warmed connection without creating a new one', async () => {
    const pool = new DeepgramConnectionPool(3, 'test-key', 10);
    await pool.warmUp('bs', 1);
    expect(pool.availableCount).toBe(1);

    const client = await pool.acquire('bs');

    expect(client).toBeDefined();
    // The pre-warmed connection was consumed, no new ones created
    expect(pool.inUseCount).toBe(1);
    expect(pool.availableCount).toBe(0);
    expect(pool.totalCount).toBe(1);
  });

  it('falls back to creating a new connection when language does not match pool entry', async () => {
    const pool = new DeepgramConnectionPool(3, 'test-key', 10);
    await pool.warmUp('bs', 1);

    // Acquire SR — pool has only BS, so a new SR connection must be created
    const client = await pool.acquire('sr');
    expect(client).toBeDefined();
    // BS entry still in pool, SR is in-use
    expect(pool.availableCount).toBe(1);
    expect(pool.inUseCount).toBe(1);
  });

  // ── release ───────────────────────────────────────────────────────

  it('release returns a healthy connection back to the pool', async () => {
    const pool = new DeepgramConnectionPool(3, 'test-key', 10);
    const client = await pool.acquire('bs');
    expect(pool.inUseCount).toBe(1);

    pool.release(client);
    expect(pool.inUseCount).toBe(0);
    expect(pool.availableCount).toBe(1);
  });

  it('release strips listeners before returning to pool', async () => {
    const pool = new DeepgramConnectionPool(3, 'test-key', 10);
    const client = await pool.acquire('bs');

    pool.release(client);

    expect(mockRemoveAllListeners).toHaveBeenCalledWith('transcript');
    expect(mockRemoveAllListeners).toHaveBeenCalledWith('error');
    expect(mockRemoveAllListeners).toHaveBeenCalledWith('reconnected');
  });

  it('release closes the connection when pool is at capacity', async () => {
    const pool = new DeepgramConnectionPool(1, 'test-key', 10);
    // Warm-up fills the single pool slot
    await pool.warmUp('bs', 1);
    expect(pool.availableCount).toBe(1);

    // Acquire and release a second client — pool is full, so it should be closed
    const client = await pool.acquire('sr');
    pool.release(client);

    expect(mockClose).toHaveBeenCalled();
    // Pool still has 1 (the warmed-up BS connection)
    expect(pool.availableCount).toBe(1);
  });

  it('release closes the connection when it is disconnected', async () => {
    mockIsConnected.mockReturnValue(false);

    const pool = new DeepgramConnectionPool(3, 'test-key', 10);
    const client = await pool.acquire('bs');
    pool.release(client);

    expect(mockClose).toHaveBeenCalled();
    expect(pool.availableCount).toBe(0);
  });

  // ── discards stale connections ────────────────────────────────────

  it('discards a stale pooled connection and creates a fresh one', async () => {
    const pool = new DeepgramConnectionPool(3, 'test-key', 10);
    await pool.warmUp('bs', 1);
    expect(pool.availableCount).toBe(1);

    // Simulate the pooled client going stale
    mockIsConnected.mockReturnValue(false);

    const client = await pool.acquire('bs');
    expect(client).toBeDefined();
    // Stale connection was discarded, a new one created and put in-use
    expect(pool.inUseCount).toBe(1);
    expect(pool.availableCount).toBe(0);
  });

  // ── maxTotal guard ────────────────────────────────────────────────

  it('throws when max total connections is reached', async () => {
    const pool = new DeepgramConnectionPool(1, 'test-key', 2);
    await pool.acquire('bs');
    await pool.acquire('sr');

    await expect(pool.acquire('bs')).rejects.toThrow('max total connections');
  });

  // ── closed pool ───────────────────────────────────────────────────

  it('throws when acquiring from a closed pool', async () => {
    const pool = new DeepgramConnectionPool(3, 'test-key', 10);
    await pool.closeAll();

    await expect(pool.acquire('bs')).rejects.toThrow('closed');
  });

  // ── closeAll ─────────────────────────────────────────────────────

  it('closeAll closes all available and in-use connections', async () => {
    const pool = new DeepgramConnectionPool(3, 'test-key', 10);
    await pool.warmUp('bs', 1);
    await pool.acquire('sr'); // in-use

    await pool.closeAll();

    expect(mockClose).toHaveBeenCalledTimes(2);
    expect(pool.availableCount).toBe(0);
    expect(pool.inUseCount).toBe(0);
  });

  // ── totalCount ───────────────────────────────────────────────────

  it('totalCount reflects available + in-use', async () => {
    const pool = new DeepgramConnectionPool(3, 'test-key', 10);
    await pool.warmUp('bs', 2);
    await pool.acquire('sr');

    expect(pool.totalCount).toBe(3); // 2 available + 1 in-use
  });
});
