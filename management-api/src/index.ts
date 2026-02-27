import { logger } from './utils/logger.js';

logger.info('Management API starting...');

async function main(): Promise<void> {
  // Config validation happens on import — process.exit(1) on invalid env
  const { config } = await import('./config.js');
  logger.info({ env: config.NODE_ENV, port: config.PORT }, 'Config loaded');

  // Lazy-load Fastify after config is confirmed valid
  const { default: Fastify } = await import('fastify');
  const { default: cors } = await import('@fastify/cors');
  const { default: helmet } = await import('@fastify/helmet');
  const { default: rateLimit } = await import('@fastify/rate-limit');

  const fastify = Fastify({
    logger: false, // We use our own pino instance
    trustProxy: true,
  });

  // ── Plugins ──────────────────────────────────────────────────────────────

  await fastify.register(cors, {
    origin: config.NODE_ENV === 'production' ? false : true,
    credentials: true,
  });

  await fastify.register(helmet, {
    contentSecurityPolicy: false,
  });

  await fastify.register(rateLimit, {
    global: false, // Per-route rate limiting via route config
    max: 100,
    timeWindow: '1 minute',
  });

  // ── Routes ───────────────────────────────────────────────────────────────

  const { authRoutes, setRedisClient } = await import('./auth/routes.js');
  const { healthRoutes } = await import('./routes/health.js');
  const { agentRoutes } = await import('./routes/agents.js');
  const { promptRoutes } = await import('./routes/prompts.js');
  const { knowledgeBaseRoutes } = await import('./routes/knowledge-bases.js');
  const { campaignRoutes } = await import('./routes/campaigns.js');
  const { dispositionRoutes } = await import('./routes/dispositions.js');
  const { leadRoutes } = await import('./routes/leads.js');

  // Configure Redis for auth routes
  try {
    const { redis } = await import('./utils/redis.js');
    setRedisClient(redis);
    logger.info('Redis client configured');
  } catch (redisErr) {
    logger.warn({ err: redisErr }, 'Redis initialization failed — refresh token blacklisting disabled');
  }

  await fastify.register(authRoutes);
  await fastify.register(healthRoutes);
  await fastify.register(agentRoutes);
  await fastify.register(promptRoutes);
  await fastify.register(knowledgeBaseRoutes);
  await fastify.register(campaignRoutes);
  await fastify.register(dispositionRoutes);
  await fastify.register(leadRoutes);

  // ── Global error handler ──────────────────────────────────────────────────

  fastify.setErrorHandler((err, _request, reply) => {
    logger.error({ err }, 'Unhandled route error');
    void reply.code(500).send({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  });

  fastify.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({
      error: 'Route not found',
      code: 'NOT_FOUND',
    });
  });

  // ── Start ─────────────────────────────────────────────────────────────────

  const address = await fastify.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info(
    { address, version: '1.0.0', env: config.NODE_ENV },
    'Management API listening',
  );

  // ── Graceful Shutdown ─────────────────────────────────────────────────────

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown signal received');
    try {
      await fastify.close();
      const { closePool } = await import('./db/pool.js');
      await closePool();
      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger.fatal({ error }, 'Failed to start Management API');
  process.exit(1);
});
