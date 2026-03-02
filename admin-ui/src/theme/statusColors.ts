import type { CampaignStatus, LeadStatus } from '../types';

export const CAMPAIGN_STATUS_COLORS: Record<CampaignStatus, { bg: string; text: string }> = {
  draft:     { bg: '#546e7a', text: '#fff' },
  active:    { bg: '#2e7d32', text: '#fff' },
  paused:    { bg: '#e65100', text: '#fff' },
  stopped:   { bg: '#c62828', text: '#fff' },
  completed: { bg: '#0277bd', text: '#fff' },
};

export const LEAD_STATUS_COLORS: Record<LeadStatus, string> = {
  new:       '#546e7a',
  queued:    '#1565c0',
  dialing:   '#f57f17',
  connected: '#2e7d32',
  disposed:  '#4a148c',
  dnc:       '#c62828',
  failed:    '#bf360c',
};

export const STATUS_TRANSITION_LABELS: Record<CampaignStatus, string> = {
  draft:     'Zu Entwurf',
  active:    'Aktivieren',
  paused:    'Pausieren',
  stopped:   'Stoppen',
  completed: '',
};
