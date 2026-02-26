# Voice System BS & SR

## Project
Real-time Voice AI system for outbound sales calls in Bosnian (bs-BA) and Serbian (sr-RS).

## Stack
- Runtime: Node.js 22+ / TypeScript 5.9+ (strict)
- Server: Fastify + @fastify/websocket
- Database: PostgreSQL 16 (pg driver, node-pg-migrate)
- Cache: Redis 7 (ioredis)
- Logging: Pino
- Validation: Zod v4
- Testing: Vitest + @vitest/coverage-v8
- Linting: ESLint 10 + typescript-eslint
- External APIs: Telnyx, Deepgram (nova-3), Azure TTS, OpenAI (gpt-4o-mini/gpt-4o)

## Architecture
- 1 Agent per language (bs-BA, sr-RS) — separate config, prompts, TTS voice
- Pipeline: Telnyx → Ring Buffer → VAD → Deepgram ASR → LLM (streaming) → Azure TTS (chunked) → Telnyx
- 3-Level Memory: Active Window (4 turns) + Summary + Structured KV
- 6-Phase State Machine: hook → qualify → pitch → objection → close → confirm
- LLM Switch: mini → full based on phase + interest score

## Conventions
- All files use ES modules (import/export)
- No `any` — strict TypeScript
- Every module needs corresponding test in tests/
- Use Zod for ALL external input validation
- Structured logging with Pino (no console.log)
- Error handling: retry with exponential backoff for external APIs
- Config via validated .env (src/config.ts)

## Commands
```
pnpm dev          # Development with hot reload
pnpm build        # TypeScript compilation
pnpm test         # Run tests
pnpm test:coverage # Tests with coverage
pnpm lint         # ESLint check
pnpm typecheck    # TypeScript type check
```
