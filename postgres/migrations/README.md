# PostgreSQL Migrations — Activi Voice AI Management Platform

These migrations extend the base schema defined in `postgres/init.sql`.
They are applied **after** `init.sql` has run and must be executed in
numerical order.

## Migration Order

| File | Description |
|------|-------------|
| `001_pgvector.sql` | Enables the `vector` extension for semantic search |
| `002_platform_users.sql` | Auth table for admin / manager / viewer accounts |
| `003_phone_numbers.sql` | Vonage numbers pool (FK to campaigns added in 007) |
| `004_ai_agents.sql` | AI agent configs + default Goran / Nikola seeds |
| `005_prompts.sql` | Versioned prompt library for all 6 call phases |
| `006_knowledge_bases.sql` | RAG tables: `knowledge_bases`, `kb_documents`, `kb_chunks` |
| `007_campaigns.sql` | Campaign management + backfills `phone_numbers` FK |
| `008_dispositions.sql` | Per-campaign call outcome codes |
| `009_leads.sql` | Lead lists and individual lead records |
| `010_dnc.sql` | Global Do-Not-Call registry |
| `011_updated_at_triggers.sql` | Trigger function + triggers for all `updated_at` columns |

## How to Apply

### Manual (psql)

```bash
for f in postgres/migrations/*.sql; do
  echo "Applying $f ..."
  psql "$DATABASE_URL" -f "$f"
done
```

### Via management-api on startup

The `management-api` service runs migrations automatically on startup using
the ordered file list above. Check `management-api/src/db/migrate.ts` for
the implementation.

### Docker Compose (development)

```bash
docker compose -f docker-compose.dev.yml up --build
```

The init container applies `init.sql` first, then the migration runner
applies `001` through `011` in order.

## Prerequisites

- PostgreSQL 16 with the `pgvector` extension installed in the image.
  The official `pgvector/pgvector:pg16` Docker image satisfies this.
- `pgcrypto` is already enabled by `init.sql` (provides `gen_random_uuid()`).

## Notes

- **Do not modify** `init.sql` tables: `calls`, `turns`, `call_metrics`,
  `call_memory`. These are owned by the orchestrator service.
- Migrations are idempotent where possible (`CREATE EXTENSION IF NOT EXISTS`,
  `CREATE OR REPLACE FUNCTION`). Re-running individual files after a partial
  failure is safe for those statements; others use `CREATE TABLE` which will
  error if the table already exists — this is intentional to prevent
  accidental re-application.
- The default admin password is `changeme123!`. Change it immediately after
  first login via the management UI or a direct SQL update.
