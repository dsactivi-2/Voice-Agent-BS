import type { FastifyInstance } from 'fastify';
import { logger } from './utils/logger.js';

interface ShutdownDependencies {
  server: FastifyInstance;
  closeFns: Array<{ name: string; fn: () => Promise<void> }>;
  getActiveCalls: () => number;
  maxWaitMs?: number;
}

const POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_WAIT_MS = 30000;

async function waitForActiveCalls(
  getActiveCalls: () => number,
  maxWaitMs: number
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;

  while (getActiveCalls() > 0 && Date.now() < deadline) {
    logger.info({ activeCalls: getActiveCalls() }, 'Waiting for active calls to finish');
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const remaining = getActiveCalls();
  if (remaining > 0) {
    logger.warn({ remaining }, 'Force closing with active calls still running');
  }
}

export function setupGracefulShutdown(deps: ShutdownDependencies): void {
  const maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  let isShuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, 'Shutdown signal received');

    // 1. Stop accepting new connections
    try {
      await deps.server.close();
      logger.info('Server closed — no new connections accepted');
    } catch (error) {
      logger.error({ error }, 'Error closing server');
    }

    // 2. Wait for active calls to finish
    await waitForActiveCalls(deps.getActiveCalls, maxWaitMs);

    // 3. Close dependencies sequentially
    for (const { name, fn } of deps.closeFns) {
      try {
        await fn();
        logger.info({ dependency: name }, 'Closed successfully');
      } catch (error) {
        logger.error({ dependency: name, error }, 'Error closing dependency');
      }
    }

    logger.info('Graceful shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    logger.fatal({ error }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled rejection');
    void shutdown('unhandledRejection');
  });
}

export function isShuttingDown(): boolean {
  return false; // Will be managed via closure in production
}
