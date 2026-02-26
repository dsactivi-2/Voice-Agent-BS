-- =============================================================
-- Migration 007: campaigns
-- Campaign management linking agents, knowledge bases, and phone numbers.
-- Also backfills the FK from phone_numbers.assigned_campaign_id
-- which could not be added in 003 because campaigns did not exist yet.
-- =============================================================

CREATE TABLE campaigns (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT         NOT NULL,
  status               TEXT         NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'active', 'paused', 'stopped', 'completed')),
  dialing_mode         TEXT         NOT NULL DEFAULT 'ratio'
                         CHECK (dialing_mode IN ('manual', 'ratio', 'predictive')),
  dial_ratio           NUMERIC(3,1) NOT NULL DEFAULT 1.0 CHECK (dial_ratio BETWEEN 0.1 AND 10.0),
  agent_id             UUID         REFERENCES ai_agents(id) ON DELETE SET NULL,
  kb_id                UUID         REFERENCES knowledge_bases(id) ON DELETE SET NULL,
  phone_number_id      UUID         REFERENCES phone_numbers(id) ON DELETE SET NULL,
  timezone             TEXT         NOT NULL DEFAULT 'Europe/Sarajevo',
  call_window_start    TIME         NOT NULL DEFAULT '09:00',
  call_window_end      TIME         NOT NULL DEFAULT '18:00',
  active_days          INT[]        NOT NULL DEFAULT '{1,2,3,4,5}',
  max_retries          INT          NOT NULL DEFAULT 3 CHECK (max_retries BETWEEN 0 AND 10),
  retry_interval_hours INT          NOT NULL DEFAULT 24 CHECK (retry_interval_hours BETWEEN 1 AND 168),
  notes                TEXT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_campaigns_status   ON campaigns (status);
CREATE INDEX idx_campaigns_agent_id ON campaigns (agent_id);

-- Add the FK from phone_numbers to campaigns now that campaigns exists.
ALTER TABLE phone_numbers
  ADD CONSTRAINT fk_phone_numbers_campaign
  FOREIGN KEY (assigned_campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;
