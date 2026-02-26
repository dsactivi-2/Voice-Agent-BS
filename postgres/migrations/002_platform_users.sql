-- =============================================================
-- Migration 002: platform_users
-- Auth table for management platform users (admins, managers, viewers).
-- =============================================================

CREATE TABLE platform_users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'manager', 'viewer')),
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_platform_users_email ON platform_users (email);

-- Default admin user (password: 'changeme123!' — bcrypt hashed, cost=12)
-- IMPORTANT: Change this password immediately after first login.
INSERT INTO platform_users (email, password_hash, role) VALUES
  ('admin@activi.io', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBPj/RK.s5uKmi', 'admin');
