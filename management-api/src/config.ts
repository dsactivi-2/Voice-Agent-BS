import { z } from 'zod/v4';
import 'dotenv/config';

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1),

  // Redis
  REDIS_URL: z.string().optional().default('redis://redis:6379'),

  // JWT
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),

  // App
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // Auth
  BCRYPT_ROUNDS: z.coerce.number().int().positive().default(12),

  // OpenAI (embeddings for KB/RAG)
  OPENAI_API_KEY: z.string().min(1),

  // KB chunking defaults
  KB_CHUNK_SIZE: z.coerce.number().int().positive().default(500),   // target tokens per chunk
  KB_CHUNK_OVERLAP: z.coerce.number().int().min(0).default(50),     // overlap in tokens
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = z.prettifyError(result.error);
    console.error('Invalid environment variables:\n', formatted);
    process.exit(1);
  }

  return result.data;
}

export type Config = z.infer<typeof envSchema>;
export const config = loadConfig();
