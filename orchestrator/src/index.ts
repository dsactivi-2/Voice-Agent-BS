import { logger } from './utils/logger.js';

logger.info('Voice System Orchestrator starting...');

// Dynamic imports to allow config validation to fail first
async function main(): Promise<void> {
  // Config validation happens on import
  const { config } = await import('./config.js');
  logger.info({ env: config.NODE_ENV, port: config.PORT }, 'Config loaded');

  // Initialize DB pool
  const { pool } = await import('./db/client.js');
  logger.info('Database pool initialized');

  // Initialize Redis
  const { redis } = await import('./cache/redis-client.js');
  logger.info('Redis connected');

  // Pre-warm TTS cache so the first call doesn't cold-synthesize phrases
  const { warmTTSCache } = await import('./tts/cache.js');
  const { synthesizeSpeech } = await import('./tts/azure-client.js');
  warmTTSCache((text, language) => synthesizeSpeech(text, language)).catch((err: unknown) => {
    logger.warn({ err }, 'TTS cache warm-up failed — calls will cold-synthesize');
  });

  // Deepgram ASR (conditional on USE_WHISPER_ONLY)
  let deepgramPool = undefined;
  const useWhisperOnly = process.env['USE_WHISPER_ONLY'] === 'true';

  if (!useWhisperOnly) {
    // Pre-warm Deepgram connection pool (primary ASR — nova-3 streaming)
    const { DeepgramConnectionPool } = await import('./deepgram/connection-pool.js');
    deepgramPool = new DeepgramConnectionPool(5, config.DEEPGRAM_API_KEY, 20);

    try {
      await Promise.all([
        deepgramPool.warmUp('bs', 2),
        deepgramPool.warmUp('sr', 1),
      ]);
      logger.info('Deepgram connection pool pre-warmed (2x BS + 1x SR)');
    } catch (err: unknown) {
      logger.warn({ err }, 'Deepgram pool warm-up failed — connections will be created on-demand');
    }
    logger.info('ASR: Deepgram nova-3 (primary) + Whisper REST (fallback)');
  } else {
    logger.info('ASR: Whisper REST ONLY (Deepgram disabled via USE_WHISPER_ONLY)');
  }

  // Start server
  const { startServer } = await import('./server.js');
  await startServer({ dbPool: pool, redis, deepgramPool });
}

main().catch((error: unknown) => {
  logger.fatal({ error }, 'Failed to start application');
  process.exit(1);
});
