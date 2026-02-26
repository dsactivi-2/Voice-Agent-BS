-- =============================================================
-- Migration 010: dnc_numbers
-- Global Do-Not-Call registry. Phone numbers here must never be dialed.
-- added_by references platform_users; SET NULL if the user is deleted.
-- =============================================================

CREATE TABLE dnc_numbers (
  id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone    TEXT        NOT NULL UNIQUE,
  reason   TEXT,
  source   TEXT        NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'call', 'import', 'api')),
  added_by UUID        REFERENCES platform_users(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dnc_phone ON dnc_numbers (phone);
