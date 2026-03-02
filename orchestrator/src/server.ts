import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyRateLimit from '@fastify/rate-limit';
import { pinoHttp } from 'pino-http';
import { logger } from './utils/logger.js';
import { config } from './config.js';
import { registerHealthRoute } from './health.js';
import { registerMetricsRoute } from './metrics/prometheus.js';
import { setupGracefulShutdown } from './graceful-shutdown.js';
import { createTelephonyProvider } from './telephony/factory.js';
import type { TelephonyEvents } from './telephony/provider.js';
import type { CallResult } from './types.js';
import type { FastifyRequest } from 'fastify';
import { CallOrchestrator } from './call-orchestrator.js';
import { routeVonageCall, routeByLanguage } from './agents/language-router.js';
import type { Language } from './types.js';
import { initiateOutboundCall } from './vonage/outbound.js';
import { z } from 'zod/v4';

// These will be injected when DB and Redis are initialized
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

interface ServerDependencies {
  dbPool: Pool;
  redis: Redis;
}

// Track active calls globally
let activeCalls = 0;

/** Active CallOrchestrator instances keyed by callId. */
const activeOrchestrators = new Map<string, CallOrchestrator>();

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

  // WebSocket support for telephony media streaming
  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: 65536, // 64KB per WebSocket frame
    },
  });

  // Rate limiting — protect webhook endpoints from flooding
  // Vonage sends webhooks from known infrastructure; 200 req/min per IP is generous
  await app.register(fastifyRateLimit, {
    global: true,
    max: 200,
    timeWindow: '1 minute',
    keyGenerator: (req: FastifyRequest): string => req.ip,
    // Skip health checks and WebSocket upgrades
    allowList: (req: FastifyRequest): boolean =>
      req.url === '/health' || req.headers['upgrade'] === 'websocket',
    errorResponseBuilder: (
      _req: FastifyRequest,
      context: { after: string; max: number },
    ) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${context.after}.`,
    }),
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

  // Prometheus metrics endpoint
  registerMetricsRoute(app);

  // --- Telephony provider ---
  // Creates the configured telephony provider (telnyx or vonage) and
  // registers its routes (webhooks, WebSocket media, etc.) on the app.
  const telephonyEvents: TelephonyEvents = {
    onCallStarted: (callId, phoneNumber, fromNumber) => {
      logger.info({ callId, phoneNumber, fromNumber }, 'Telephony call started');
    },

    onMediaSessionReady: (callId, session, meta) => {
      logger.info({ callId, phoneNumber: meta.phoneNumber, fromNumber: meta.fromNumber }, 'Media session ready — creating CallOrchestrator');

      // Outbound calls carry an explicit language in meta; inbound calls fall back
      // to VONAGE_DEFAULT_LANGUAGE via routeVonageCall.
      const agentConfig = meta.language
        ? routeByLanguage(meta.language as Language)
        : routeVonageCall(meta.fromNumber);

      const orchestrator = new CallOrchestrator({
        callId,
        phoneNumber: meta.phoneNumber,
        agentConfig,
        campaignId: 'default',
        mediaSession: session as unknown as import('./telephony/provider.js').MediaSession,
      });

      activeOrchestrators.set(callId, orchestrator);

      const orchestratorStartMs = Date.now();

      orchestrator.start()
        .then(() => {
          logger.info({ callId, latencyMs: Date.now() - orchestratorStartMs }, 'CallOrchestrator started successfully');
        })
        .catch((err: unknown) => {
          logger.error({ err, callId, latencyMs: Date.now() - orchestratorStartMs }, 'CallOrchestrator failed to start');
          activeOrchestrators.delete(callId);
        });
    },

    onCallEnded: (callId, reason) => {
      logger.info({ callId, reason }, 'Telephony call ended');
      const orchestrator = activeOrchestrators.get(callId);
      if (orchestrator) {
        activeOrchestrators.delete(callId);
        const validResults = new Set<string>(['success', 'no_answer', 'rejected', 'error', 'timeout']);
        const callResult: CallResult = validResults.has(reason) ? (reason as CallResult) : 'success';
        orchestrator.stop(callResult).catch((err: unknown) => {
          logger.error({ err, callId }, 'Error stopping orchestrator on call end');
        });
      }
    },

    onAudioReceived: (callId, audio) => {
      // Audio is now handled directly by CallOrchestrator via session event binding.
      // This callback is a no-op but kept for interface compliance.
      logger.debug({ callId, audioBytes: audio.length }, 'Audio received (handled by orchestrator)');
    },

    onError: (callId, error) => {
      logger.error({ callId, err: error }, 'Telephony error');
      const orchestrator = activeOrchestrators.get(callId);
      if (orchestrator) {
        activeOrchestrators.delete(callId);
        orchestrator.stop('error').catch((err: unknown) => {
          logger.error({ err, callId }, 'Error stopping orchestrator on telephony error');
        });
      }
    },
  };

  const telephonyProvider = createTelephonyProvider(telephonyEvents);
  telephonyProvider.registerRoutes(app);

  logger.info(
    { provider: telephonyProvider.name },
    'Telephony provider registered',
  );

  // Outbound call API
  const outboundBodySchema = z.object({
    phoneNumber: z.string().min(1),
    language: z.enum(['bs-BA', 'sr-RS']).default('bs-BA'),
    campaignId: z.string().min(1).default('manual'),
  });

  app.post('/api/calls/outbound', async (req, reply) => {
    const parsed = outboundBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request', details: z.treeifyError(parsed.error) });
    }

    const { phoneNumber, language, campaignId } = parsed.data;

    try {
      const result = await initiateOutboundCall(phoneNumber, language, campaignId);
      return await reply.status(200).send({ success: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, phoneNumber, campaignId }, 'Outbound call failed');
      return reply.status(500).send({ error: message });
    }
  });

  // Setup graceful shutdown
  setupGracefulShutdown({
    server: app,
    getActiveCalls,
    closeFns: [
      { name: 'redis', fn: () => { deps.redis.disconnect(); return Promise.resolve(); } },
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
