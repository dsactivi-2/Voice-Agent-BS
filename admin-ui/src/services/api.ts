import { axiosClient, BASE_URL } from '../providers/axiosClient';
import type {
  CampaignStatus,
  CsvPreviewResult,
  ImportResult,
  KbDocument,
  Lead,
  LeadStatus,
  DncCheckResult,
} from '../types';

// ── CAMPAIGNS ─────────────────────────────────────────────────────────────────

/** PATCH /campaigns/:id/status — State Machine Transition */
export const setCampaignStatus = (id: string, status: CampaignStatus) =>
  axiosClient.patch<{ success: boolean }>(`/campaigns/${id}/status`, { status });

// ── PROMPTS ───────────────────────────────────────────────────────────────────

/** GET /prompts/name/:name/versions */
export const getPromptVersions = (name: string) =>
  axiosClient.get<{ versions: unknown[]; total: number }>(
    `/prompts/name/${encodeURIComponent(name)}/versions`
  );

/** PATCH /prompts/:id/active — explicit bool, KEIN Toggle! */
export const setPromptActive = (id: string, is_active: boolean) =>
  axiosClient.patch<{ success: boolean }>(`/prompts/${id}/active`, { is_active });

// ── LEADS ─────────────────────────────────────────────────────────────────────

/** GET /campaigns/:campaignId/lists/:listId */
export const getLeadList = (campaignId: string, listId: string) =>
  axiosClient.get<{ list: { id: string; name: string; total_leads: number } }>(
    `/campaigns/${campaignId}/lists/${listId}`
  );

/** GET /campaigns/:campaignId/lists/:listId/leads */
export const getLeadsInList = (
  campaignId: string,
  listId: string,
  params: { page?: number; pageSize?: number; status?: LeadStatus; search?: string }
) =>
  axiosClient.get<{ leads: Lead[]; total: number; page: number; pageSize: number }>(
    `/campaigns/${campaignId}/lists/${listId}/leads`,
    { params }
  );

/** POST /campaigns/:campaignId/lists/preview — MULTIPART */
export const previewCsv = (campaignId: string, file: File) => {
  const form = new FormData();
  form.append('file', file);
  return axiosClient.post<CsvPreviewResult>(
    `/campaigns/${campaignId}/lists/preview`,
    form,
    { headers: { 'Content-Type': 'multipart/form-data' } }
  );
};

/** POST /campaigns/:campaignId/lists/import — MULTIPART
 *  mapping MUST include phone_primary key */
export const importCsv = (
  campaignId: string,
  file: File,
  mapping: Record<string, string>,
  name?: string
) => {
  const form = new FormData();
  form.append('file', file);
  form.append('mapping', JSON.stringify(mapping));
  if (name) form.append('name', name);
  return axiosClient.post<ImportResult>(
    `/campaigns/${campaignId}/lists/import`,
    form,
    { headers: { 'Content-Type': 'multipart/form-data' } }
  );
};

/** PATCH /leads/:leadId/disposition
 *  WICHTIG: disposition_code (string), NOT dispositionId! */
export const setLeadDisposition = (
  leadId: string,
  disposition_code: string,
  notes?: string
) =>
  axiosClient.patch<{ success: boolean; status: 'disposed' | 'dnc' }>(
    `/leads/${leadId}/disposition`,
    { disposition_code, notes }
  );

// ── KNOWLEDGE BASES ───────────────────────────────────────────────────────────

/** GET /knowledge-bases/:id/documents */
export const getKbDocuments = (kbId: string) =>
  axiosClient.get<{ documents: KbDocument[]; total: number }>(
    `/knowledge-bases/${kbId}/documents`
  );

/** POST /knowledge-bases/:id/documents — JSON (text or url) */
export const addKbDocument = (
  kbId: string,
  payload: {
    source_type: 'text' | 'url';
    content?: string;
    source_url?: string;
    sync_frequency?: 'never' | 'daily' | 'weekly' | 'monthly';
    filename?: string;
  }
) =>
  axiosClient.post<{ docId: string; status: 'processing' }>(
    `/knowledge-bases/${kbId}/documents`,
    payload
  );

/** POST /knowledge-bases/:id/documents/pdf — MULTIPART, max 50MB */
export const uploadKbPdf = (kbId: string, file: File) => {
  const form = new FormData();
  form.append('file', file);
  return axiosClient.post<{ docId: string; status: 'processing' }>(
    `/knowledge-bases/${kbId}/documents/pdf`,
    form,
    { headers: { 'Content-Type': 'multipart/form-data' } }
  );
};

/** DELETE /knowledge-bases/:kbId/documents/:docId */
export const deleteKbDocument = (kbId: string, docId: string) =>
  axiosClient.delete(`/knowledge-bases/${kbId}/documents/${docId}`);

/** POST /knowledge-bases/:id/search — needs pgvector on server! */
export const searchKb = (
  kbId: string,
  query: string,
  limit?: number,
  threshold?: number
) =>
  axiosClient.post<{ results: Array<{ content: string; score: number }> }>(
    `/knowledge-bases/${kbId}/search`,
    { query, limit, threshold }
  );

// ── DNC ───────────────────────────────────────────────────────────────────────

/** POST /dnc/check — ACHTUNG: 'phone' NICHT 'phoneNumber'! */
export const checkDnc = (phone: string) =>
  axiosClient.post<DncCheckResult>('/dnc/check', { phone });

// ── SSE ───────────────────────────────────────────────────────────────────────

/** Full SSE URL — note double /api/ in path */
export const SSE_URL = `${BASE_URL}/api/events`;
