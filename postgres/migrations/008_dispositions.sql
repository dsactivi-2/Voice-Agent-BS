-- =============================================================
-- Migration 008: dispositions
-- Per-campaign call outcome codes (e.g. "SALE", "NOT_INTERESTED", "DNC").
-- code must be unique within a campaign.
-- =============================================================

CREATE TABLE dispositions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       UUID        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  code              TEXT        NOT NULL,
  label             TEXT        NOT NULL,
  is_success        BOOLEAN     NOT NULL DEFAULT false,
  is_dnc            BOOLEAN     NOT NULL DEFAULT false,
  retry_allowed     BOOLEAN     NOT NULL DEFAULT true,
  retry_after_hours INT         NOT NULL DEFAULT 24,
  sort_order        INT         NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_dispo_code UNIQUE (campaign_id, code)
);

CREATE INDEX idx_dispositions_campaign ON dispositions (campaign_id);
