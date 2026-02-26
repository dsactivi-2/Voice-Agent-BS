import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { pinoHttp } from 'pino-http';
import { logger } from './utils/logger.js';
import { config } from './config.js';
import { registerHealthRoute } from './health.js';
import { setupGracefulShutdown } from './graceful-shutdown.js';

// These will be injected when DB and Redis are initialized
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

interface ServerDependencies {
  dbPool: Pool;
  redis: Redis;
}

// Track active calls globally
let activeCalls = 0;

export function getActiveCalls(): number {
  return activeCalls;
}

export function incrementActiveCalls(): void {
  activeCalls++;
}

export function decrementActiveCalls(): void {
  if (activeCalls > 0) activeCalls--;
}

export async function createServer(deps: ServerDependencies) {
  const app = Fastify({
    logger: false, // We use pino-http separately for more control
    trustProxy: true,
    requestTimeout: 30000,
    bodyLimit: 1048576, // 1MB
  });

  // WebSocket support for Telnyx media streaming
  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: 65536, // 64KB per WebSocket frame
    },
  });

  // HTTP request logging via Pino
  app.addHook('onRequest', (req, _reply, done) => {
    // Skip logging for health checks to avoid noise
    if (req.url === '/health') {
      done();
      return;
    }
    pinoHttp({ logger })(req.raw, _reply.raw, done);
  });

  // Register health check endpoint
  registerHealthRoute(app, {
    dbPool: deps.dbPool,
    redis: deps.redis,
    getActiveCalls,
    version: '0.1.0',
    startedAt: Date.now(),
  });

  // Prometheus metrics endpoint (placeholder — AP-16 will implement fully)
  app.get('/metrics', async (_req, reply) => {
    await reply.status(200).send('# Prometheus metrics will be added in AP-16\n');
  });

  // Telnyx webhook endpoint (placeholder — AP-07 will implement)
  app.post('/telnyx/webhook', async (req, reply) => {
    logger.debug({ body: req.body }, 'Telnyx webhook received');
    await reply.status(200).send({ status: 'ok' });
  });

  // Telnyx media WebSocket (placeholder — AP-07 will implement)
  app.get('/telnyx/media', { websocket: true }, (socket, _req) => {
    logger.info('Telnyx media WebSocket connected');
    incrementActiveCalls();

    socket.on('close', () => {
      decrementActiveCalls();
      logger.info('Telnyx media WebSocket disconnected');
    });

    socket.on('error', (error: Error) => {
      logger.error({ error }, 'WebSocket error');
      decrementActiveCalls();
    });
  });

  // Outbound call API (placeholder — AP-07 will implement)
  app.post('/api/calls/outbound', async (_req, reply) => {
    await reply.status(501).send({ error: 'Not implemented yet — see AP-07' });
  });

  // Setup graceful shutdown
  setupGracefulShutdown({
    server: app,
    getActiveCalls,
    closeFns: [
      { name: 'redis', fn: async () => deps.redis.disconnect() },
      { name: 'postgres', fn: async () => { await deps.dbPool.end(); } },
    ],
  });

  return app;
}

export async function startServer(deps: ServerDependencies): Promise<void> {
  const app = await createServer(deps);

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'Server started');
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
}
