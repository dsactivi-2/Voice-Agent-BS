import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('connect', () => {
  logger.debug('PostgreSQL client connected');
});

pool.on('acquire', () => {
  logger.trace('PostgreSQL client acquired from pool');
});

pool.on('remove', () => {
  logger.debug('PostgreSQL client removed from pool');
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle PostgreSQL client');
});

/**
 * Executes a parameterised SQL query against the connection pool.
 * Returns the full QueryResult so callers can access rows, rowCount, etc.
 *
 * @param text   - SQL statement with $1 … $N placeholders
 * @param values - Ordered parameter values
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(text, values);
    const durationMs = Date.now() - start;
    logger.trace({ query: text, durationMs, rowCount: result.rowCount }, 'Query executed');
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    logger.error({ err, query: text, durationMs }, 'Query failed');
    throw err;
  }
}

/**
 * Drains the connection pool and releases all clients.
 * Call during graceful shutdown to avoid dangling connections.
 */
export async function closePool(): Promise<void> {
  logger.info('Closing PostgreSQL connection pool');
  await pool.end();
  logger.info('PostgreSQL connection pool closed');
}
