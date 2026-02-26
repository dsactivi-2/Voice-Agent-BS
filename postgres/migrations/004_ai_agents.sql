-- =============================================================
-- Migration 004: ai_agents
-- AI agent configurations for the 6-phase state machine.
-- Seeds default agents matching existing orchestrator config.
-- =============================================================

CREATE TABLE ai_agents (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT         NOT NULL,
  language       TEXT         NOT NULL CHECK (language IN ('bs-BA', 'sr-RS')),
  tts_voice      TEXT         NOT NULL,
  llm_model      TEXT         NOT NULL DEFAULT 'gpt-4o-mini',
  temperature    NUMERIC(3,2) NOT NULL DEFAULT 0.70 CHECK (temperature >= 0 AND temperature <= 2),
  prompts        JSONB        NOT NULL DEFAULT '{}',
  memory_config  JSONB        NOT NULL DEFAULT '{"window_turns": 4, "summary_interval": 5, "cross_call_enabled": true}',
  is_active      BOOLEAN      NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_agents_language ON ai_agents (language);
CREATE INDEX idx_ai_agents_active   ON ai_agents (is_active);

-- Seed default agents matching existing orchestrator config.
-- Prompts contain all 6 phase slots; fill them via the management API.
INSERT INTO ai_agents (name, language, tts_voice, llm_model, prompts) VALUES
  (
    'Goran',
    'bs-BA',
    'bs-BA-GoranNeural',
    'gpt-4o-mini',
    '{
      "system":    "Ti si Goran, AI asistent kompanije Activi.",
      "hook":      "",
      "qualify":   "",
      "pitch":     "",
      "objection": "",
      "close":     "",
      "confirm":   ""
    }'
  ),
  (
    'Nikola',
    'sr-RS',
    'sr-RS-NicholasNeural',
    'gpt-4o-mini',
    '{
      "system":    "Ti si Nikola, AI asistent kompanije Activi.",
      "hook":      "",
      "qualify":   "",
      "pitch":     "",
      "objection": "",
      "close":     "",
      "confirm":   ""
    }'
  );
