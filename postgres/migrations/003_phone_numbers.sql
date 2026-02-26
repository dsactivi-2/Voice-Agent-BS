-- =============================================================
-- Migration 003: phone_numbers
-- Vonage phone numbers managed in the platform.
-- NOTE: The FK to campaigns is deferred — added in 007_campaigns.sql
--       once the campaigns table exists.
-- =============================================================

CREATE TABLE phone_numbers (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  number               TEXT        NOT NULL UNIQUE,
  language             TEXT        NOT NULL CHECK (language IN ('bs-BA', 'sr-RS')),
  vonage_country       TEXT,
  label                TEXT,
  is_active            BOOLEAN     NOT NULL DEFAULT true,
  assigned_campaign_id UUID,       -- FK constraint added in 007_campaigns.sql
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_phone_numbers_language ON phone_numbers (language);
CREATE INDEX idx_phone_numbers_active   ON phone_numbers (is_active);
