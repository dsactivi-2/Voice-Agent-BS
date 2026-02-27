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

  // Start server
  const { startServer } = await import('./server.js');
  await startServer({ dbPool: pool, redis });
}

main().catch((error: unknown) => {
  logger.fatal({ error }, 'Failed to start application');
  process.exit(1);
});
