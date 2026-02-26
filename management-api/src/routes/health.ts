import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/pool.js';
import { logger } from '../utils/logger.js';

async function healthHandler(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await reply.code(200).send({
    status: 'ok',
    service: 'management-api',
    timestamp: new Date().toISOString(),
  });
}

async function readinessHandler(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await pool.query('SELECT 1');
    await reply.code(200).send({
      status: 'ok',
      service: 'management-api',
      timestamp: new Date().toISOString(),
      checks: {
        database: 'ok',
      },
    });
  } catch (err) {
    logger.error({ err }, 'Readiness check failed — database unreachable');
    await reply.code(503).send({
      status: 'error',
      service: 'management-api',
      timestamp: new Date().toISOString(),
      checks: {
        database: 'error',
      },
    });
  }
}

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/health', {}, healthHandler);
  fastify.get('/health/ready', {}, readinessHandler);
}
