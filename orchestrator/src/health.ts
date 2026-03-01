import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { HealthCheckResult, HealthStatus } from './types.js';
import { logger } from './utils/logger.js';

interface HealthDependencies {
  dbPool: Pool;
  redis: Redis;
  getActiveCalls: () => number;
  version: string;
  startedAt: number;
}

interface ServiceCheck {
  status: string;
  latencyMs: number;
}

async function checkService(
  name: string,
  fn: () => Promise<void>,
  timeoutMs: number
): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => { reject(new Error(`${name} health check timeout`)); }, timeoutMs)
      ),
    ]);
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (error) {
    logger.warn({ service: name, error }, 'Health check failed');
    return { status: 'error', latencyMs: Date.now() - start };
  }
}

export function registerHealthRoute(
  app: FastifyInstance,
  deps: HealthDependencies
): void {
  app.get('/health', async (_req: FastifyRequest, reply: FastifyReply) => {
    const [postgres, redis] = await Promise.all([
      checkService('postgres', async () => {
        await deps.dbPool.query('SELECT 1');
      }, 2000),
      checkService('redis', async () => {
        await deps.redis.ping();
      }, 1000),
    ]);

    // External service checks — only test reachability, not full connection
    const [deepgram, azureTts, openai] = await Promise.all([
      checkService('deepgram', async () => {
        // Use GET — HEAD returns 405 on Deepgram's API
        const res = await fetch('https://api.deepgram.com/v1/projects', {
          method: 'GET',
          signal: AbortSignal.timeout(3000),
        }).catch(() => ({ ok: false }));
        // 401 means reachable but unauthorized — fine for health check
        if (!res.ok && 'status' in res && (res).status !== 401) {
          throw new Error('Deepgram unreachable');
        }
      }, 3000),
      checkService('azure_tts', async () => {
        const region = process.env['AZURE_REGION'] ?? 'westeurope';
        // Use voices/list endpoint — HEAD on issueToken returns 404
        const res = await fetch(
          `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
          { method: 'GET', signal: AbortSignal.timeout(3000) }
        ).catch(() => ({ ok: false }));
        // 401 means reachable but unauthorized — fine for health check
        if (!res.ok && 'status' in res && (res).status !== 401) {
          throw new Error('Azure TTS unreachable');
        }
      }, 3000),
      checkService('openai', async () => {
        const res = await fetch('https://api.openai.com/v1/models', {
          method: 'HEAD',
          signal: AbortSignal.timeout(3000),
        }).catch(() => ({ ok: false }));
        // 401 means reachable — fine for health check
        if (!res.ok && 'status' in res && (res).status !== 401) {
          throw new Error('OpenAI unreachable');
        }
      }, 3000),
    ]);

    const checks = { postgres, redis, deepgram, azureTts, openai };

    // Critical services: postgres + redis must be healthy
    const criticalChecks = [postgres, redis];
    const externalChecks = [deepgram, azureTts, openai];

    const hasCriticalError = criticalChecks.some((c) => c.status === 'error');
    const hasExternalError = externalChecks.some((c) => c.status === 'error');
    const hasSlow = Object.values(checks).some((c) => c.latencyMs > 1000 && c.status === 'ok');

    let status: HealthStatus;
    if (hasCriticalError) {
      status = 'unhealthy';
    } else if (hasExternalError || hasSlow) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    const result: HealthCheckResult = {
      status,
      uptime: Math.floor((Date.now() - deps.startedAt) / 1000),
      checks,
      activeCalls: deps.getActiveCalls(),
      version: deps.version,
    };

    const statusCode = status === 'unhealthy' ? 503 : 200;
    await reply.status(statusCode).send(result);
  });
}
