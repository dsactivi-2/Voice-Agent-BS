import { logger } from './utils/logger.js';

logger.info('Voice System Orchestrator starting...');
logger.info('This is a placeholder entry point. Server setup follows in AP-04.');

// Placeholder — will be replaced by Fastify server in AP-04
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down');
  process.exit(0);
});
