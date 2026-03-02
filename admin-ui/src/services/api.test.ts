import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../providers/axiosClient', () => ({
  axiosClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  BASE_URL: 'http://test.activi.io/api/manage',
}));

import { axiosClient } from '../providers/axiosClient';
import {
  setCampaignStatus,
  getPromptVersions,
  setPromptActive,
  getLeadList,
  getLeadsInList,
  previewCsv,
  importCsv,
  setLeadDisposition,
  getKbDocuments,
  addKbDocument,
  uploadKbPdf,
  deleteKbDocument,
  searchKb,
  checkDnc,
  SSE_URL,
} from './api';

const mockGet = vi.mocked(axiosClient.get);
const mockPost = vi.mocked(axiosClient.post);
const mockPatch = vi.mocked(axiosClient.patch);
const mockDelete = vi.mocked(axiosClient.delete);

const OK = { data: { success: true } };

beforeEach(() => {
  vi.clearAllMocks();
});

// ── SSE URL ──────────────────────────────────────────────────────────────────

describe('SSE_URL', () => {
  it('appends /api/events to BASE_URL', () => {
    expect(SSE_URL).toBe('http://test.activi.io/api/manage/api/events');
  });
});

// ── Campaigns ────────────────────────────────────────────────────────────────

describe('setCampaignStatus', () => {
  it('sends PATCH /campaigns/:id/status with status in body', async () => {
    mockPatch.mockResolvedValueOnce(OK);

    await setCampaignStatus('camp-1', 'active');

    expect(mockPatch).toHaveBeenCalledWith('/campaigns/camp-1/status', { status: 'active' });
  });
});

// ── Prompts ──────────────────────────────────────────────────────────────────

describe('getPromptVersions', () => {
  it('sends GET /prompts/name/:name/versions with encoded name', async () => {
    mockGet.mockResolvedValueOnce({ data: { versions: [], total: 0 } });

    await getPromptVersions('my prompt/v2');

    expect(mockGet).toHaveBeenCalledWith('/prompts/name/my%20prompt%2Fv2/versions');
  });
});

describe('setPromptActive', () => {
  it('sends PATCH /prompts/:id/active with is_active=true', async () => {
    mockPatch.mockResolvedValueOnce(OK);

    await setPromptActive('p-1', true);

    expect(mockPatch).toHaveBeenCalledWith('/prompts/p-1/active', { is_active: true });
  });

  it('sends PATCH /prompts/:id/active with is_active=false', async () => {
    mockPatch.mockResolvedValueOnce(OK);

    await setPromptActive('p-2', false);

    expect(mockPatch).toHaveBeenCalledWith('/prompts/p-2/active', { is_active: false });
  });
});

// ── Leads ────────────────────────────────────────────────────────────────────

describe('getLeadList', () => {
  it('sends GET /campaigns/:cid/lists/:lid', async () => {
    mockGet.mockResolvedValueOnce({ data: { list: { id: 'l-1', name: 'List A', total_leads: 10 } } });

    await getLeadList('camp-1', 'list-1');

    expect(mockGet).toHaveBeenCalledWith('/campaigns/camp-1/lists/list-1');
  });
});

describe('getLeadsInList', () => {
  it('sends GET with pagination and filter params', async () => {
    mockGet.mockResolvedValueOnce({ data: { leads: [], total: 0, page: 1, pageSize: 25 } });

    await getLeadsInList('camp-1', 'list-1', { page: 2, pageSize: 50, status: 'new', search: 'Max' });

    expect(mockGet).toHaveBeenCalledWith(
      '/campaigns/camp-1/lists/list-1/leads',
      { params: { page: 2, pageSize: 50, status: 'new', search: 'Max' } },
    );
  });

  it('sends GET without optional params when omitted', async () => {
    mockGet.mockResolvedValueOnce({ data: { leads: [], total: 0, page: 1, pageSize: 25 } });

    await getLeadsInList('camp-1', 'list-2', {});

    expect(mockGet).toHaveBeenCalledWith('/campaigns/camp-1/lists/list-2/leads', { params: {} });
  });
});

describe('previewCsv', () => {
  it('sends POST multipart with the file appended to FormData', async () => {
    mockPost.mockResolvedValueOnce({ data: { headers: [], preview_rows: [], total_rows: 0, mappable_fields: [] } });

    const file = new File(['a,b\n1,2'], 'test.csv', { type: 'text/csv' });
    await previewCsv('camp-1', file);

    const [url, body, config] = mockPost.mock.calls[0];
    expect(url).toBe('/campaigns/camp-1/lists/preview');
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get('file')).toBe(file);
    expect((config as { headers: Record<string, string> }).headers['Content-Type']).toBe('multipart/form-data');
  });
});

describe('importCsv', () => {
  it('sends POST with file, mapping JSON, and optional name', async () => {
    mockPost.mockResolvedValueOnce({ data: { listId: 'l-new', imported: 5, skipped_dnc: 0, skipped_duplicate: 0, total_in_file: 5 } });

    const file = new File(['phone\n123'], 'leads.csv', { type: 'text/csv' });
    const mapping = { phone_primary: 'phone' };
    await importCsv('camp-1', file, mapping, 'My Import');

    const [url, body, config] = mockPost.mock.calls[0];
    expect(url).toBe('/campaigns/camp-1/lists/import');
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get('file')).toBe(file);
    expect((body as FormData).get('mapping')).toBe(JSON.stringify(mapping));
    expect((body as FormData).get('name')).toBe('My Import');
    expect((config as { headers: Record<string, string> }).headers['Content-Type']).toBe('multipart/form-data');
  });

  it('omits name field when not provided', async () => {
    mockPost.mockResolvedValueOnce({ data: { listId: 'l-2', imported: 0, skipped_dnc: 0, skipped_duplicate: 0, total_in_file: 0 } });

    const file = new File([], 'empty.csv', { type: 'text/csv' });
    await importCsv('camp-1', file, {});

    const [, body] = mockPost.mock.calls[0];
    expect((body as FormData).get('name')).toBeNull();
  });
});

describe('setLeadDisposition', () => {
  it('sends PATCH /leads/:id/disposition with code and notes', async () => {
    mockPatch.mockResolvedValueOnce({ data: { success: true, status: 'disposed' } });

    await setLeadDisposition('lead-1', 'INTERESTED', 'Very keen');

    expect(mockPatch).toHaveBeenCalledWith('/leads/lead-1/disposition', {
      disposition_code: 'INTERESTED',
      notes: 'Very keen',
    });
  });

  it('sends PATCH without notes when omitted', async () => {
    mockPatch.mockResolvedValueOnce({ data: { success: true, status: 'disposed' } });

    await setLeadDisposition('lead-2', 'DNC');

    expect(mockPatch).toHaveBeenCalledWith('/leads/lead-2/disposition', {
      disposition_code: 'DNC',
      notes: undefined,
    });
  });
});

// ── Knowledge Bases ──────────────────────────────────────────────────────────

describe('getKbDocuments', () => {
  it('sends GET /knowledge-bases/:id/documents', async () => {
    mockGet.mockResolvedValueOnce({ data: { documents: [], total: 0 } });

    await getKbDocuments('kb-1');

    expect(mockGet).toHaveBeenCalledWith('/knowledge-bases/kb-1/documents');
  });
});

describe('addKbDocument', () => {
  it('sends POST with text payload', async () => {
    mockPost.mockResolvedValueOnce({ data: { docId: 'doc-1', status: 'processing' } });

    await addKbDocument('kb-1', { source_type: 'text', content: 'Hello world', filename: 'doc.txt' });

    expect(mockPost).toHaveBeenCalledWith('/knowledge-bases/kb-1/documents', {
      source_type: 'text',
      content: 'Hello world',
      filename: 'doc.txt',
    });
  });

  it('sends POST with url payload and sync_frequency', async () => {
    mockPost.mockResolvedValueOnce({ data: { docId: 'doc-2', status: 'processing' } });

    await addKbDocument('kb-1', { source_type: 'url', source_url: 'https://example.com', sync_frequency: 'daily' });

    expect(mockPost).toHaveBeenCalledWith('/knowledge-bases/kb-1/documents', {
      source_type: 'url',
      source_url: 'https://example.com',
      sync_frequency: 'daily',
    });
  });
});

describe('uploadKbPdf', () => {
  it('sends POST multipart to /documents/pdf with file', async () => {
    mockPost.mockResolvedValueOnce({ data: { docId: 'doc-3', status: 'processing' } });

    const file = new File(['%PDF-1.4'], 'manual.pdf', { type: 'application/pdf' });
    await uploadKbPdf('kb-2', file);

    const [url, body, config] = mockPost.mock.calls[0];
    expect(url).toBe('/knowledge-bases/kb-2/documents/pdf');
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get('file')).toBe(file);
    expect((config as { headers: Record<string, string> }).headers['Content-Type']).toBe('multipart/form-data');
  });
});

describe('deleteKbDocument', () => {
  it('sends DELETE /knowledge-bases/:kbId/documents/:docId', async () => {
    mockDelete.mockResolvedValueOnce({ data: {} });

    await deleteKbDocument('kb-1', 'doc-99');

    expect(mockDelete).toHaveBeenCalledWith('/knowledge-bases/kb-1/documents/doc-99');
  });
});

describe('searchKb', () => {
  it('sends POST with query, limit, and threshold', async () => {
    mockPost.mockResolvedValueOnce({ data: { results: [] } });

    await searchKb('kb-1', 'find me', 5, 0.8);

    expect(mockPost).toHaveBeenCalledWith('/knowledge-bases/kb-1/search', {
      query: 'find me',
      limit: 5,
      threshold: 0.8,
    });
  });

  it('sends POST with only query when limit/threshold omitted', async () => {
    mockPost.mockResolvedValueOnce({ data: { results: [] } });

    await searchKb('kb-1', 'just a query');

    expect(mockPost).toHaveBeenCalledWith('/knowledge-bases/kb-1/search', {
      query: 'just a query',
      limit: undefined,
      threshold: undefined,
    });
  });
});

// ── DNC ──────────────────────────────────────────────────────────────────────

describe('checkDnc', () => {
  it('sends POST /dnc/check with phone field', async () => {
    mockPost.mockResolvedValueOnce({ data: { phone: '+49123', is_dnc: false } });

    await checkDnc('+49123456789');

    expect(mockPost).toHaveBeenCalledWith('/dnc/check', { phone: '+49123456789' });
  });
});
