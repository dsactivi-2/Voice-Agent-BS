// ── Auth ──────────────────────────────────────────────────────────────────────
export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; role: string };
}

// ── Agent ─────────────────────────────────────────────────────────────────────
export interface AgentPrompts {
  system?: string;
  hook?: string;
  qualify?: string;
  pitch?: string;
  objection?: string;
  close?: string;
  confirm?: string;
}

export interface AgentMemoryConfig {
  window_turns?: number;
  summary_interval?: number;
  cross_call_enabled?: boolean;
}

export interface Agent {
  id: string;
  name: string;
  language: 'bs-BA' | 'sr-RS';
  tts_voice: string;
  llm_model: 'gpt-4o-mini' | 'gpt-4o';
  temperature: number;
  is_active: boolean;
  prompts?: AgentPrompts;
  memory_config?: AgentMemoryConfig;
}

// ── Campaign ──────────────────────────────────────────────────────────────────
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'stopped' | 'completed';

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  dialing_mode: 'manual' | 'ratio' | 'predictive';
  dial_ratio: number;
  agent_id?: string;
  kb_id?: string;
  phone_number_id?: string;
  timezone: string;
  call_window_start: string;
  call_window_end: string;
  active_days: number[];
  max_retries: number;
  retry_interval_hours: number;
  notes?: string;
}

export const STATUS_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft:     ['active'],
  active:    ['paused', 'stopped'],
  paused:    ['active', 'stopped'],
  stopped:   ['draft'],
  completed: [],
};

// ── Disposition ───────────────────────────────────────────────────────────────
export interface Disposition {
  id: string;
  campaign_id: string;
  code: string;
  label: string;
  is_success: boolean;
  is_dnc: boolean;
  retry_allowed: boolean;
  retry_after_hours: number;
  sort_order: number;
}

// ── Prompt ────────────────────────────────────────────────────────────────────
export type PromptPhase =
  | 'system'
  | 'hook'
  | 'qualify'
  | 'pitch'
  | 'objection'
  | 'close'
  | 'confirm';

export interface Prompt {
  id: string;
  name: string;
  language: 'bs-BA' | 'sr-RS' | 'any';
  phase: PromptPhase;
  content: string;
  version: number;
  is_active: boolean;
}

// ── Knowledge Base ────────────────────────────────────────────────────────────
export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  chunks_to_retrieve: number;
  similarity_threshold: number;
}

export interface KbDocument {
  id: string;
  kb_id: string;
  source_type: 'text' | 'url' | 'pdf';
  filename?: string;
  source_url?: string;
  content?: string;
  status: 'processing' | 'ready' | 'error';
  sync_frequency?: 'never' | 'daily' | 'weekly' | 'monthly';
}

// ── Lead ──────────────────────────────────────────────────────────────────────
export interface LeadList {
  id: string;
  campaign_id: string;
  name: string;
  total_leads: number;
  imported_at: string;
}

export interface CsvPreviewResult {
  headers: string[];
  preview_rows: string[][];
  total_rows: number;
  mappable_fields: string[];
}

export interface ImportResult {
  listId: string;
  imported: number;
  skipped_dnc: number;
  skipped_duplicate: number;
  total_in_file: number;
}

export type LeadStatus =
  | 'new'
  | 'queued'
  | 'dialing'
  | 'connected'
  | 'disposed'
  | 'dnc'
  | 'failed';

export interface Lead {
  id: string;
  list_id: string;
  phone_primary: string;
  first_name?: string;
  last_name?: string;
  status: LeadStatus;
  disposition_code?: string;
  notes?: string;
}

// ── DNC ───────────────────────────────────────────────────────────────────────
export interface DncEntry {
  id: string;
  phone: string;
  reason?: string;
  source: 'manual' | 'import' | 'api';
  created_at: string;
}

export interface DncCheckResult {
  phone: string;
  is_dnc: boolean;
  reason?: string;
}

// ── SSE Event ─────────────────────────────────────────────────────────────────
export interface SseEvent {
  type: string;
  callId?: string;
  ts: number;
  [key: string]: unknown;
}
