-- =============================================================
-- Migration 006: knowledge_bases, kb_documents, kb_chunks
-- RAG infrastructure. Requires pgvector (001_pgvector.sql).
-- Embeddings are 1536-dimensional (text-embedding-3-small / ada-002).
-- IVFFlat index uses cosine distance; lists=100 suits up to ~1M chunks.
-- =============================================================

CREATE TABLE knowledge_bases (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT         NOT NULL,
  description          TEXT,
  chunks_to_retrieve   INT          NOT NULL DEFAULT 3 CHECK (chunks_to_retrieve BETWEEN 1 AND 10),
  similarity_threshold NUMERIC(3,2) NOT NULL DEFAULT 0.60 CHECK (similarity_threshold BETWEEN 0.00 AND 1.00),
  last_synced_at       TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------

CREATE TABLE kb_documents (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_id          UUID        NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  source_type    TEXT        NOT NULL CHECK (source_type IN ('pdf', 'url', 'text', 'docx')),
  source_url     TEXT,
  filename       TEXT,
  content        TEXT        NOT NULL,
  sync_frequency TEXT        NOT NULL DEFAULT 'never' CHECK (sync_frequency IN ('never', 'daily', 'weekly', 'monthly')),
  status         TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'error')),
  error_message  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_kb_documents_kb_id  ON kb_documents (kb_id);
CREATE INDEX idx_kb_documents_status ON kb_documents (status);

-- -----------------------------------------------------------------

CREATE TABLE kb_chunks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID        NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  chunk_index INT         NOT NULL,
  content     TEXT        NOT NULL,
  token_count INT,
  embedding   vector(1536),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_chunk UNIQUE (document_id, chunk_index)
);

-- IVFFlat index for approximate nearest-neighbour search (cosine distance).
-- Build after initial bulk insert for best performance.
CREATE INDEX ON kb_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_kb_chunks_document ON kb_chunks (document_id);
