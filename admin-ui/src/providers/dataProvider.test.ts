import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./axiosClient', () => ({
  axiosClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
  },
}));

import { dataProvider } from './dataProvider';
import { axiosClient } from './axiosClient';

const mockGet = vi.mocked(axiosClient.get);
const mockPost = vi.mocked(axiosClient.post);
const mockPut = vi.mocked(axiosClient.put);
const mockDelete = vi.mocked(axiosClient.delete);

const defaultListParams = {
  pagination: { page: 1, perPage: 25 },
  sort: { field: 'id', order: 'ASC' as const },
  filter: {},
};

describe('dataProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getList', () => {
    it('fetches agents from /agents', async () => {
      mockGet.mockResolvedValueOnce({
        data: { agents: [{ id: 'ag-1', name: 'Goran' }], total: 1 },
      });

      const result = await dataProvider.getList('agents', defaultListParams);

      expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('/agents'));
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('fetches dispositions via nested URL when meta.campaignId is set', async () => {
      mockGet.mockResolvedValueOnce({ data: { dispositions: [], total: 0 } });

      await dataProvider.getList('dispositions', {
        ...defaultListParams,
        meta: { campaignId: 'camp-123' },
      });

      expect(mockGet).toHaveBeenCalledWith(
        expect.stringContaining('/campaigns/camp-123/dispositions'),
      );
    });

    it('normalizes items that have uuid field instead of id', async () => {
      mockGet.mockResolvedValueOnce({
        data: { agents: [{ uuid: 'uuid-abc', name: 'Test' }], total: 1 },
      });

      const result = await dataProvider.getList('agents', defaultListParams);

      expect(result.data[0].id).toBe('uuid-abc');
    });

    it('includes pagination and sort params in the query string', async () => {
      mockGet.mockResolvedValueOnce({ data: { campaigns: [], total: 0 } });

      await dataProvider.getList('campaigns', {
        pagination: { page: 2, perPage: 10 },
        sort: { field: 'name', order: 'DESC' as const },
        filter: {},
      });

      const calledUrl = mockGet.mock.calls[0][0] as string;
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('pageSize=10');
      expect(calledUrl).toContain('sort=name');
      expect(calledUrl).toContain('order=DESC');
    });
  });

  describe('getOne', () => {
    it('fetches /agents/:id and returns the agent record', async () => {
      mockGet.mockResolvedValueOnce({
        data: { agent: { id: 'ag-1', name: 'Goran', language: 'bs-BA' } },
      });

      const result = await dataProvider.getOne('agents', { id: 'ag-1' });

      expect(mockGet).toHaveBeenCalledWith('/agents/ag-1');
      expect(result.data.id).toBe('ag-1');
    });
  });

  describe('create', () => {
    it('posts to /agents and returns the created record', async () => {
      const payload = { name: 'New Agent', language: 'bs-BA' };
      mockPost.mockResolvedValueOnce({
        data: { id: 'new-ag', ...payload },
      });

      const result = await dataProvider.create('agents', { data: payload });

      expect(mockPost).toHaveBeenCalledWith('/agents', payload);
      expect(result.data.id).toBe('new-ag');
    });
  });

  describe('update', () => {
    it('puts to /agents/:id and merges previous + new data', async () => {
      mockPut.mockResolvedValueOnce({ data: {} });

      const result = await dataProvider.update('agents', {
        id: 'ag-1',
        data: { name: 'Updated' },
        previousData: { id: 'ag-1', name: 'Old' },
      });

      expect(mockPut).toHaveBeenCalledWith('/agents/ag-1', { name: 'Updated' });
      expect(result.data.name).toBe('Updated');
    });
  });

  describe('delete', () => {
    it('calls DELETE /agents/:id', async () => {
      mockDelete.mockResolvedValueOnce({ data: {} });

      await dataProvider.delete('agents', {
        id: 'ag-1',
        previousData: { id: 'ag-1' },
      });

      expect(mockDelete).toHaveBeenCalledWith('/agents/ag-1');
    });
  });

  describe('getMany', () => {
    it('fetches each id individually and returns all records', async () => {
      mockGet
        .mockResolvedValueOnce({ data: { agent: { id: 'ag-1', name: 'Goran' } } })
        .mockResolvedValueOnce({ data: { agent: { id: 'ag-2', name: 'Vesna' } } });

      const result = await dataProvider.getMany('agents', { ids: ['ag-1', 'ag-2'] });

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(mockGet).toHaveBeenCalledWith('/agents/ag-1');
      expect(mockGet).toHaveBeenCalledWith('/agents/ag-2');
      expect(result.data).toHaveLength(2);
      expect(result.data[0].id).toBe('ag-1');
      expect(result.data[1].id).toBe('ag-2');
    });

    it('normalizes uuid field in getMany results', async () => {
      mockGet.mockResolvedValueOnce({
        data: { agent: { uuid: 'uuid-99', name: 'Test' } },
      });

      const result = await dataProvider.getMany('agents', { ids: ['uuid-99'] });

      expect(result.data[0].id).toBe('uuid-99');
    });
  });

  describe('getManyReference', () => {
    it('delegates to getList with target/id merged into filter', async () => {
      mockGet.mockResolvedValueOnce({ data: { dispositions: [], total: 0 } });

      await dataProvider.getManyReference('dispositions', {
        target: 'campaign_id',
        id: 'camp-42',
        pagination: { page: 1, perPage: 10 },
        sort: { field: 'code', order: 'ASC' as const },
        filter: { is_success: true },
        meta: { campaignId: 'camp-42' },
      });

      const calledUrl = mockGet.mock.calls[0][0] as string;
      // Should use nested URL because meta.campaignId is set
      expect(calledUrl).toContain('/campaigns/camp-42/dispositions');
      // Should include both the existing filter and the target/id filter
      expect(calledUrl).toContain('campaign_id=camp-42');
      expect(calledUrl).toContain('is_success=true');
    });
  });

  describe('deleteMany', () => {
    it('deletes each id individually', async () => {
      mockDelete
        .mockResolvedValueOnce({ data: {} })
        .mockResolvedValueOnce({ data: {} });

      const result = await dataProvider.deleteMany('agents', { ids: ['ag-1', 'ag-2'] });

      expect(mockDelete).toHaveBeenCalledTimes(2);
      expect(mockDelete).toHaveBeenCalledWith('/agents/ag-1');
      expect(mockDelete).toHaveBeenCalledWith('/agents/ag-2');
      expect(result.data).toEqual(['ag-1', 'ag-2']);
    });
  });

  describe('updateMany', () => {
    it('throws — not supported', async () => {
      await expect(dataProvider.updateMany('agents', { ids: ['1'], data: {} })).rejects.toThrow(
        'updateMany not supported',
      );
    });
  });
});
