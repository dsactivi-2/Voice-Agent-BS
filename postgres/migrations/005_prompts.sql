-- =============================================================
-- Migration 005: prompts
-- Versioned prompt library for all 6 call phases plus system prompt.
-- name + version must be unique; bump version to iterate on a prompt.
-- =============================================================

CREATE TABLE prompts (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  language   TEXT        NOT NULL CHECK (language IN ('bs-BA', 'sr-RS', 'any')),
  phase      TEXT        NOT NULL CHECK (phase IN ('system', 'hook', 'qualify', 'pitch', 'objection', 'close', 'confirm')),
  content    TEXT        NOT NULL,
  version    INT         NOT NULL DEFAULT 1,
  is_active  BOOLEAN     NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_prompts_language ON prompts (language);
CREATE INDEX idx_prompts_phase    ON prompts (phase);
CREATE INDEX idx_prompts_active   ON prompts (is_active);

CREATE UNIQUE INDEX idx_prompts_name_version ON prompts (name, version);
