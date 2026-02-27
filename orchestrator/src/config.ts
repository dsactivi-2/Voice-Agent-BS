import { z } from 'zod/v4';
import 'dotenv/config';

const envSchema = z.object({
  // Telephony Provider
  TELEPHONY_PROVIDER: z.enum(['telnyx', 'vonage']).default('telnyx'),

  // Telnyx (optional — required when TELEPHONY_PROVIDER=telnyx)
  TELNYX_API_KEY: z.string().optional(),
  TELNYX_PUBLIC_KEY: z.string().optional(),
  TELNYX_APP_ID: z.string().optional(),
  TELNYX_PHONE_BS: z.string().optional(),
  TELNYX_PHONE_SR: z.string().optional(),

  // Vonage (optional — required when TELEPHONY_PROVIDER=vonage)
  VONAGE_API_KEY: z.string().optional(),
  VONAGE_API_SECRET: z.string().optional(),
  VONAGE_APPLICATION_ID: z.string().optional(),
  VONAGE_PRIVATE_KEY_PATH: z.string().optional(),
  VONAGE_PHONE_NUMBER: z.string().optional(),
  VONAGE_SIGNATURE_SECRET: z.string().optional(),

  // Deepgram
  DEEPGRAM_API_KEY: z.string().min(1),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1),

  // Azure TTS
  AZURE_SPEECH_KEY: z.string().min(1),
  AZURE_REGION: z.string().default('westeurope'),

  // Postgres
  POSTGRES_DB: z.string().default('voice_system'),
  POSTGRES_USER: z.string().default('voice_app'),
  POSTGRES_PASSWORD: z.string().min(1),
  DATABASE_URL: z.string().min(1),

  // App
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),

  // LLM
  LLM_MINI_MODEL: z.string().default('gpt-4o-mini'),
  LLM_FULL_MODEL: z.string().default('gpt-4o'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  LLM_SWITCH_INTEREST_THRESHOLD: z.coerce.number().min(0).max(1).default(0.72),
  LLM_SWITCH_COMPLEXITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.60),

  // VAD
  VAD_ENDPOINTING_MS: z.coerce.number().int().positive().default(300),
  VAD_GRACE_MS: z.coerce.number().int().positive().default(200),
  VAD_BARGE_IN_MIN_MS: z.coerce.number().int().positive().default(150),
  VAD_SILENCE_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  // TTS
  TTS_VOICE_BS: z.string().default('bs-BA-GoranNeural'),
  TTS_VOICE_SR: z.string().default('sr-RS-NicholasNeural'),
  TTS_FORMAT: z.string().default('raw-16khz-16bit-mono-pcm'),
  TTS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(86400),

  // Adaptive Delay
  ADAPTIVE_DELAY_MIN_MS: z.coerce.number().int().nonnegative().default(200),
  ADAPTIVE_DELAY_MAX_MS: z.coerce.number().int().nonnegative().default(800),

  // Silence Pressure
  SILENCE_PRESSURE_AFTER_OFFER_MS: z.coerce.number().int().nonnegative().default(2500),

  // Memory
  MEMORY_SUMMARY_INTERVAL_TURNS: z.coerce.number().int().positive().default(5),
  MEMORY_ACTIVE_WINDOW_TURNS: z.coerce.number().int().positive().default(4),
  MEMORY_CROSS_CALL_ENABLED: z.coerce.boolean().default(true),

  // Anti-Loop
  ANTI_LOOP_COOLDOWN_HOURS: z.coerce.number().int().positive().default(24),
  /** Comma-separated phone numbers (E.164) that bypass the anti-loop check.
   *  Use this for automated test callers (e.g. Bland.ai) so they can call
   *  repeatedly without hitting the 24-hour cooldown. */
  ANTI_LOOP_BYPASS_NUMBERS: z.string().default(''),

  // Ring Buffer
  RING_BUFFER_SIZE_KB: z.coerce.number().int().positive().default(32),
  RING_BUFFER_CHANNELS: z.coerce.number().int().positive().default(50),

  // A/B Testing
  AB_TEST_ENABLED: z.coerce.boolean().default(false),
  AB_TEST_GROUPS: z.string().default('mini_only,mini_to_full,full_only'),
}).refine(
  (data) => {
    if (data.TELEPHONY_PROVIDER === 'telnyx') {
      return (
        !!data.TELNYX_API_KEY &&
        !!data.TELNYX_PUBLIC_KEY &&
        !!data.TELNYX_APP_ID &&
        !!data.TELNYX_PHONE_BS &&
        !!data.TELNYX_PHONE_SR
      );
    }
    return true;
  },
  {
    message:
      'When TELEPHONY_PROVIDER=telnyx, all TELNYX_* environment variables are required: ' +
      'TELNYX_API_KEY, TELNYX_PUBLIC_KEY, TELNYX_APP_ID, TELNYX_PHONE_BS, TELNYX_PHONE_SR',
  },
).refine(
  (data) => {
    if (data.TELEPHONY_PROVIDER === 'vonage') {
      return (
        !!data.VONAGE_API_KEY &&
        !!data.VONAGE_API_SECRET &&
        !!data.VONAGE_APPLICATION_ID &&
        !!data.VONAGE_PRIVATE_KEY_PATH &&
        !!data.VONAGE_PHONE_NUMBER
      );
    }
    return true;
  },
  {
    message:
      'When TELEPHONY_PROVIDER=vonage, all VONAGE_* environment variables are required: ' +
      'VONAGE_API_KEY, VONAGE_API_SECRET, VONAGE_APPLICATION_ID, VONAGE_PRIVATE_KEY_PATH, VONAGE_PHONE_NUMBER',
  },
);

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
