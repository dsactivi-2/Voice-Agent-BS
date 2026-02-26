import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted ensures the mock fn is initialised BEFORE vi.mock is hoisted.
// This is the correct pattern for Vitest ES module mocking.
// ---------------------------------------------------------------------------
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  query: mockQuery,
  pool: {},
  closePool: vi.fn(),
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

// Import the module under test AFTER mocks are registered
import {
  createCall,
  updateCallResult,
  getCallByCallId,
  insertTurn,
  getTurnsByCallId,
  insertMetric,
  getCallMemory,
  upsertCallMemory,
  type CallRow,
  type TurnRow,
  type CallMemoryRow,
} from '../../src/db/queries.js';

// Typed convenience alias
const queryMock = mockQuery as MockedFunction<typeof mockQuery>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueryResult<T>(rows: T[], rowCount = rows.length) {
  return { rows, rowCount, command: '', oid: 0, fields: [] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('db/queries', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  // -------------------------------------------------------------------------
  // createCall
  // -------------------------------------------------------------------------

  describe('createCall', () => {
    it('inserts a call with all optional fields', async () => {
      queryMock.mockResolvedValueOnce(makeQueryResult([], 1));

      await createCall({
        callId: 'call-001',
        phoneNumber: '+38761000001',
        language: 'bs-BA',
        campaignId: 'camp-alpha',
        abGroup: 'mini_only',
        llmModeFinal: 'mini',
      });

      expect(queryMock).toHaveBeenCalledOnce();
      const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/INSERT INTO calls/i);
      expect(params).toEqual([
        'call-001',
        '+38761000001',
        'bs-BA',
        'camp-alpha',
        'mini_only',
        'mini',
      ]);
    });

    it('inserts a call with null optional fields when omitted', async () => {
      queryMock.mockResolvedValueOnce(makeQueryResult([], 1));

      await createCall({
        callId: 'call-002',
        phoneNumber: '+38111000002',
        language: 'sr-RS',
      });

      const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(params[3]).toBeNull(); // campaignId
      expect(params[4]).toBeNull(); // abGroup
      expect(params[5]).toBeNull(); // llmModeFinal
    });

    it('re-throws errors from the underlying query', async () => {
      const dbError = new Error('unique violation');
      queryMock.mockRejectedValueOnce(dbError);

      await expect(
        createCall({ callId: 'dup', phoneNumber: '+1', language: 'bs-BA' }),
      ).rejects.toThrow('unique violation');
    });
  });

  // -------------------------------------------------------------------------
  // updateCallResult
  // -------------------------------------------------------------------------

  describe('updateCallResult', () => {
    it('updates a call with result and all optional fields', async () => {
      queryMock.mockResolvedValueOnce(makeQueryResult([], 1));

      await updateCallResult({
        callId: 'call-001',
        result: 'success',
        durationSec: 120,
        turnCount: 8,
        errorLog: undefined,
      });

      const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/UPDATE calls/i);
      expect(params[0]).toBe('call-001');
      expect(params[1]).toBe('success');
      expect(params[2]).toBeNull(); // errorLog
      expect(params[3]).toBe(120);
      expect(params[4]).toBe(8);
    });

    it('resolves without throwing when no rows are matched (rowCount 0)', async () => {
      queryMock.mockResolvedValueOnce(makeQueryResult([], 0));

      await expect(
        updateCallResult({ callId: 'missing-call', result: 'error' }),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getCallByCallId
  // -------------------------------------------------------------------------

  describe('getCallByCallId', () => {
    it('returns the call row when found', async () => {
      const row: Partial<CallRow> = {
        call_id: 'call-001',
        phone_number: '+38761000001',
        language: 'bs-BA',
        result: 'success',
        turn_count: 5,
      };
      queryMock.mockResolvedValueOnce(makeQueryResult([row]));

      const result = await getCallByCallId('call-001');

      expect(result).toEqual(row);
      const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/SELECT/i);
      expect(params).toEqual(['call-001']);
    });

    it('returns null when no call is found', async () => {
      queryMock.mockResolvedValueOnce(makeQueryResult([]));

      const result = await getCallByCallId('nonexistent-call');

      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // insertTurn
  // -------------------------------------------------------------------------

  describe('insertTurn', () => {
    it('inserts a turn with all fields populated', async () => {
      queryMock.mockResolvedValueOnce(makeQueryResult([], 1));

      await insertTurn({
        callId: 'call-001',
        turnNumber: 3,
        speaker: 'user',
        text: 'Da, zanimljivo mi je.',
        interestScore: 0.82,
        complexityScore: 0.45,
        llmMode: 'mini',
        latencyMs: 310,
      });

      const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/INSERT INTO turns/i);
      expect(params).toEqual([
        'call-001',
        3,
        'user',
        'Da, zanimljivo mi je.',
        0.82,
        0.45,
        'mini',
        310,
      ]);
    });

    it('inserts a bot turn with null optional fields', async () => {
      queryMock.mockResolvedValueOnce(makeQueryResult([], 1));

      await insertTurn({
        callId: 'call-002',
        turnNumber: 1,
        speaker: 'bot',
        text: 'Dobar dan! Mogu li da razgovaram sa...',
      });

      const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(params[4]).toBeNull(); // interestScore
      expect(params[5]).toBeNull(); // complexityScore
      expect(params[6]).toBeNull(); // llmMode
      expect(params[7]).toBeNull(); // latencyMs
    });
  });

  // -------------------------------------------------------------------------
  // getTurnsByCallId
  // -------------------------------------------------------------------------

  describe('getTurnsByCallId', () => {
    it('returns ordered turns for the call', async () => {
      const rows: Partial<TurnRow>[] = [
        { call_id: 'call-001', turn_number: 1, speaker: 'bot', text: 'Hello' },
        { call_id: 'call-001', turn_number: 2, speaker: 'user', text: 'Hi' },
      ];
      queryMock.mockResolvedValueOnce(makeQueryResult(rows));

      const result = await getTurnsByCallId('call-001');

      expect(result).toHaveLength(2);
      expect(result[0]?.turn_number).toBe(1);
      expect(result[1]?.turn_number).toBe(2);
    });

    it('returns an empty array when the call has no turns', async () => {
      queryMock.mockResolvedValueOnce(makeQueryResult([]));

      const result = await getTurnsByCallId('call-no-turns');

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // insertMetric
  // -------------------------------------------------------------------------

  describe('insertMetric', () => {
    it('inserts a metric row with correct parameters', async () => {
      queryMock.mockResolvedValueOnce(makeQueryResult([], 1));

      await insertMetric('call-001', 'rtt_ms', 47.5);

      const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/INSERT INTO call_metrics/i);
      expect(params).toEqual(['call-001', 'rtt_ms', 47.5]);
    });
  });

  // -------------------------------------------------------------------------
  // getCallMemory
  // -------------------------------------------------------------------------

  describe('getCallMemory', () => {
    it('returns the memory row when found', async () => {
      const row: Partial<CallMemoryRow> = {
        phone_number: '+38761000001',
        campaign_id: 'camp-alpha',
        call_count: 2,
        outcome: 'success',
      };
      queryMock.mockResolvedValueOnce(makeQueryResult([row]));

      const result = await getCallMemory('+38761000001', 'camp-alpha');

      expect(result).toEqual(row);
      const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual(['+38761000001', 'camp-alpha']);
    });

    it('returns null when no memory record exists for the caller', async () => {
      queryMock.mockResolvedValueOnce(makeQueryResult([]));

      const result = await getCallMemory('+38761999999', 'camp-beta');

      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // upsertCallMemory
  // -------------------------------------------------------------------------

  describe('upsertCallMemory', () => {
    it('inserts a new memory record with all fields', async () => {
      queryMock.mockResolvedValueOnce(makeQueryResult([], 1));

      await upsertCallMemory({
        phoneNumber: '+38761000001',
        language: 'bs-BA',
        campaignId: 'camp-alpha',
        conversationSummary: 'Caller expressed high interest in fibre plan.',
        structuredMemory: {
          customerName: 'Amer',
          objections: ['price'],
          tone: 'positive',
          microCommitment: true,
        },
        outcome: 'success',
        sentimentScore: 0.78,
      });

      const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/INSERT INTO call_memory/i);
      expect(sql).toMatch(/ON CONFLICT/i);
      expect(params[0]).toBe('+38761000001');
      expect(params[1]).toBe('bs-BA');
      expect(params[2]).toBe('camp-alpha');
      expect(params[3]).toBe('Caller expressed high interest in fibre plan.');
      // structured_memory is JSON-serialised before being passed as $5
      expect(JSON.parse(params[4] as string)).toMatchObject({ customerName: 'Amer' });
      expect(params[5]).toBe('success');
      expect(params[6]).toBe(0.78);
    });

    it('upserts with null optional fields when they are omitted', async () => {
      queryMock.mockResolvedValueOnce(makeQueryResult([], 1));

      await upsertCallMemory({
        phoneNumber: '+38761000001',
        language: 'bs-BA',
      });

      const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(params[2]).toBeNull(); // campaignId
      expect(params[3]).toBeNull(); // conversationSummary
      expect(params[4]).toBeNull(); // structuredMemory
      expect(params[5]).toBeNull(); // outcome
      expect(params[6]).toBeNull(); // sentimentScore
    });

    it('re-throws database errors to the caller', async () => {
      queryMock.mockRejectedValueOnce(new Error('connection refused'));

      await expect(
        upsertCallMemory({ phoneNumber: '+1', language: 'sr-RS' }),
      ).rejects.toThrow('connection refused');
    });
  });
});
