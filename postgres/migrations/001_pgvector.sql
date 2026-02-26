-- =============================================================
-- Migration 001: pgvector extension
-- Enables semantic vector search for knowledge base chunks.
-- Requires PostgreSQL with pgvector installed (pgvector >= 0.5.0).
-- =============================================================

CREATE EXTENSION IF NOT EXISTS vector;
