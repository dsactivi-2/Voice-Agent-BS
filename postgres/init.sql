-- =============================================================
-- Voice System — Database Initialisation Script
-- Runs once on first container start via docker-entrypoint-initdb.d
-- =============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- provides gen_random_uuid()

-- =============================================================
-- Table: calls
-- One row per inbound/outbound call session.
-- =============================================================
CREATE TABLE calls (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id         TEXT        NOT NULL UNIQUE,
    phone_number    TEXT        NOT NULL,
    language        TEXT        NOT NULL CHECK (language IN ('bs-BA', 'sr-RS')),
    campaign_id     TEXT,
    ab_group        TEXT        CHECK (ab_group IN ('mini_only', 'mini_to_full', 'full_only')),
    llm_mode_final  TEXT        CHECK (llm_mode_final IN ('mini', 'full')),
    duration_sec    INTEGER,
    turn_count      INTEGER     DEFAULT 0,
    result          TEXT        CHECK (result IN ('success', 'no_answer', 'rejected', 'error', 'timeout')),
    error_log       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMPTZ
);

CREATE INDEX idx_calls_created_at ON calls (created_at DESC);
CREATE INDEX idx_calls_campaign    ON calls (campaign_id, ab_group);
CREATE INDEX idx_calls_language    ON calls (language);
CREATE INDEX idx_calls_result      ON calls (result);

-- =============================================================
-- Table: turns
-- One row per conversation turn (user utterance or bot reply).
-- =============================================================
CREATE TABLE turns (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id          TEXT        NOT NULL REFERENCES calls(call_id),
    turn_number      INTEGER     NOT NULL,
    speaker          TEXT        NOT NULL CHECK (speaker IN ('user', 'bot')),
    text             TEXT        NOT NULL,
    interest_score   REAL,
    complexity_score REAL,
    llm_mode         TEXT        CHECK (llm_mode IN ('mini', 'full')),
    latency_ms       INTEGER,
    timestamp        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_turn UNIQUE (call_id, turn_number, speaker)
);

CREATE INDEX idx_turns_call_id   ON turns (call_id);
CREATE INDEX idx_turns_timestamp ON turns (timestamp DESC);

-- =============================================================
-- Table: call_metrics
-- Time-series metrics attached to a specific call (e.g. RTT, CPU).
-- =============================================================
CREATE TABLE call_metrics (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id      TEXT        NOT NULL REFERENCES calls(call_id),
    metric_name  TEXT        NOT NULL,
    metric_value REAL        NOT NULL,
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_metrics_call ON call_metrics (call_id);
CREATE INDEX idx_metrics_name ON call_metrics (metric_name, recorded_at DESC);

-- =============================================================
-- Table: call_memory
-- Cross-call persistent memory, keyed by phone + campaign.
-- Allows the bot to recall prior interactions with the same caller.
-- =============================================================
CREATE TABLE call_memory (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number         TEXT        NOT NULL,
    language             TEXT        NOT NULL CHECK (language IN ('bs-BA', 'sr-RS')),
    campaign_id          TEXT,
    conversation_summary TEXT,
    structured_memory    JSONB,
    outcome              TEXT,
    sentiment_score      REAL,
    call_count           INTEGER     DEFAULT 1,
    last_call_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_phone_campaign UNIQUE (phone_number, campaign_id)
);

CREATE INDEX idx_memory_phone     ON call_memory (phone_number);
CREATE INDEX idx_memory_last_call ON call_memory (last_call_at DESC);

-- =============================================================
-- Management Platform Tables
-- NOTE: Run migrations/001_pgvector.sql through 011_updated_at_triggers.sql
-- These are applied via the management-api service on startup or manually.
-- See postgres/migrations/README.md for instructions.
-- =============================================================
