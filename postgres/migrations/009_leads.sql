-- =============================================================
-- Migration 009: lead_lists, leads
-- Lead management: CSV-imported contacts assigned to campaigns.
-- custom_fields holds arbitrary key-value data from the import file.
-- =============================================================

CREATE TABLE lead_lists (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  filename        TEXT,
  total_count     INT         NOT NULL DEFAULT 0,
  processed_count INT         NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_lead_lists_campaign ON lead_lists (campaign_id);

-- -----------------------------------------------------------------

CREATE TABLE leads (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id          UUID        NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
  campaign_id      UUID        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  phone_primary    TEXT        NOT NULL,
  phone_alt1       TEXT,
  phone_alt2       TEXT,
  phone_alt3       TEXT,
  phone_alt4       TEXT,
  first_name       TEXT,
  last_name        TEXT,
  email            TEXT,
  company          TEXT,
  custom_fields    JSONB       NOT NULL DEFAULT '{}',
  status           TEXT        NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new', 'queued', 'dialing', 'connected', 'disposed', 'dnc', 'failed')),
  disposition_code TEXT,
  retry_count      INT         NOT NULL DEFAULT 0,
  last_called_at   TIMESTAMPTZ,
  call_uuid        TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_leads_campaign    ON leads (campaign_id);
CREATE INDEX idx_leads_list_id     ON leads (list_id);
CREATE INDEX idx_leads_status      ON leads (status);
CREATE INDEX idx_leads_phone       ON leads (phone_primary);
CREATE INDEX idx_leads_last_called ON leads (last_called_at);
