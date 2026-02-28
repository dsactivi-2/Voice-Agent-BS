import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../middleware/auth.js';
import { eventStreamManager } from '../services/event-stream.js';
import { logger } from '../utils/logger.js';

interface EventsQuerystring {
  callId?: string;
}

/**
 * GET /api/events
 *
 * Server-Sent Events endpoint for real-time call event streaming.
 * Requires valid JWT in Authorization header.
 * Optional query param: ?callId=xxx to filter events for a specific call.
 *
 * SSE format:
 *   data: {"type":"call.started","callId":"...","ts":...}\n\n
 *   : ping\n\n  (heartbeat every 30s)
 */
export async function eventRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: EventsQuerystring }>(
    '/api/events',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [authenticate],
    },
    async (
      request: FastifyRequest<{ Querystring: EventsQuerystring }>,
      reply: FastifyReply,
    ): Promise<void> => {
      const { callId } = request.query;

      // Take full control of the raw response — Fastify won't touch it after hijack
      reply.hijack();
      const res = reply.raw;

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx/caddy buffering
      res.writeHead(200);

      // Initial keepalive comment confirms connection to the client
      res.write(': connected\n\n');

      eventStreamManager.addClient(res, callId);

      logger.info(
        { userId: request.user?.userId, callId, connections: eventStreamManager.connectionCount },
        'SSE client connected',
      );

      // Heartbeat: keep proxies and browsers from closing idle connections
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(heartbeat);
        }
      }, 30_000);

      request.raw.on('close', () => {
        clearInterval(heartbeat);
        eventStreamManager.removeClient(res);
        logger.info({ userId: request.user?.userId, callId }, 'SSE client disconnected');
      });
    },
  );
}
