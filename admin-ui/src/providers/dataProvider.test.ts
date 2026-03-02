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

  describe('updateMany', () => {
    it('throws — not supported', async () => {
      await expect(dataProvider.updateMany('agents', { ids: ['1'], data: {} })).rejects.toThrow(
        'updateMany not supported',
      );
    });
  });
});
