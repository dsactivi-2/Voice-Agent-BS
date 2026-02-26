import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod/v4';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken, getTokenRemainingTtl } from './jwt.js';
import { authenticate } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

// ─── Zod Schemas ────────────────────────────────────────────────────────────

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
});

const logoutBodySchema = z.object({
  refreshToken: z.string().min(1),
});

// ─── DB row type ─────────────────────────────────────────────────────────────

interface PlatformUserRow {
  id: string;
  email: string;
  password_hash: string;
  role: string;
}

// ─── Redis helper ─────────────────────────────────────────────────────────────
// We use a lightweight Redis interface via ioredis or a fallback in-memory map.
// The interface is typed to allow easy mocking in tests.

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode: 'EX', time: number): Promise<string | null>;
}

// Module-level redis instance — injected via plugin options so tests can mock.
let redisClient: RedisClient | null = null;

export function setRedisClient(client: RedisClient): void {
  redisClient = client;
}

function getRedis(): RedisClient {
  if (!redisClient) {
    throw new Error('Redis client not configured');
  }
  return redisClient;
}

// ─── Route Handlers ──────────────────────────────────────────────────────────

async function loginHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parseResult = loginBodySchema.safeParse(request.body);

  if (!parseResult.success) {
    await reply.code(400).send({
      error: 'Validation failed',
      code: 'INVALID_BODY',
    });
    return;
  }

  const { email, password } = parseResult.data;

  let userRow: PlatformUserRow | undefined;

  try {
    const result = await query<PlatformUserRow>(
      'SELECT id, email, password_hash, role FROM platform_users WHERE email = $1 LIMIT 1',
      [email],
    );
    userRow = result.rows[0];
  } catch (err) {
    logger.error({ err }, 'Database error during login');
    await reply.code(500).send({
      error: 'Internal server error',
      code: 'DB_ERROR',
    });
    return;
  }

  // Constant-time comparison — always run bcrypt even if user not found
  // to prevent timing-based user enumeration.
  const hashToCompare =
    userRow?.password_hash ??
    '$2b$12$invalidhashinvalid.invalidhashinvalidhashXXXXXXXXXXXXXXX';

  let passwordMatch = false;
  try {
    passwordMatch = await bcrypt.compare(password, hashToCompare);
  } catch (err) {
    logger.error({ err }, 'bcrypt compare error during login');
    await reply.code(500).send({
      error: 'Internal server error',
      code: 'AUTH_ERROR',
    });
    return;
  }

  if (!userRow || !passwordMatch) {
    logger.warn({ email }, 'Failed login attempt');
    await reply.code(401).send({
      error: 'Invalid credentials',
      code: 'INVALID_CREDENTIALS',
    });
    return;
  }

  const accessToken = signAccessToken({
    userId: userRow.id,
    email: userRow.email,
    role: userRow.role,
  });

  const refreshToken = signRefreshToken({ userId: userRow.id });

  logger.info({ userId: userRow.id, email: userRow.email }, 'User logged in');

  await reply.code(200).send({
    accessToken,
    refreshToken,
    user: {
      id: userRow.id,
      email: userRow.email,
      role: userRow.role,
    },
  });
}

async function refreshHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parseResult = refreshBodySchema.safeParse(request.body);

  if (!parseResult.success) {
    await reply.code(400).send({
      error: 'Validation failed',
      code: 'INVALID_BODY',
    });
    return;
  }

  const { refreshToken } = parseResult.data;

  let tokenPayload: { userId: string; jti?: string };
  try {
    tokenPayload = verifyRefreshToken(refreshToken);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.warn({ message }, 'Refresh token verification failed');
    await reply.code(401).send({
      error: 'Invalid or expired refresh token',
      code: 'INVALID_REFRESH_TOKEN',
    });
    return;
  }

  // Check blacklist
  if (tokenPayload.jti) {
    try {
      const redis = getRedis();
      const blacklisted = await redis.get(`blacklist:refresh:${tokenPayload.jti}`);
      if (blacklisted !== null) {
        logger.warn({ userId: tokenPayload.userId, jti: tokenPayload.jti }, 'Blacklisted refresh token used');
        await reply.code(401).send({
          error: 'Refresh token has been revoked',
          code: 'TOKEN_REVOKED',
        });
        return;
      }
    } catch (err) {
      logger.error({ err }, 'Redis error during blacklist check');
      // Fail open: allow refresh if Redis is unavailable, log the error
    }
  }

  // Look up user to ensure they still exist
  let userRow: Pick<PlatformUserRow, 'id' | 'email' | 'role'> | undefined;
  try {
    const result = await query<Pick<PlatformUserRow, 'id' | 'email' | 'role'>>(
      'SELECT id, email, role FROM platform_users WHERE id = $1 LIMIT 1',
      [tokenPayload.userId],
    );
    userRow = result.rows[0];
  } catch (err) {
    logger.error({ err }, 'Database error during token refresh');
    await reply.code(500).send({
      error: 'Internal server error',
      code: 'DB_ERROR',
    });
    return;
  }

  if (!userRow) {
    await reply.code(401).send({
      error: 'User not found',
      code: 'USER_NOT_FOUND',
    });
    return;
  }

  const newAccessToken = signAccessToken({
    userId: userRow.id,
    email: userRow.email,
    role: userRow.role,
  });

  logger.info({ userId: userRow.id }, 'Access token refreshed');

  await reply.code(200).send({ accessToken: newAccessToken });
}

async function logoutHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parseResult = logoutBodySchema.safeParse(request.body);

  if (!parseResult.success) {
    await reply.code(400).send({
      error: 'Validation failed',
      code: 'INVALID_BODY',
    });
    return;
  }

  const { refreshToken } = parseResult.data;

  // Verify and extract jti from refresh token (even if expired, decode it)
  let tokenPayload: { userId: string; jti?: string } | null = null;
  try {
    tokenPayload = verifyRefreshToken(refreshToken);
  } catch {
    // Token is invalid/expired — still return success (idempotent logout)
    logger.debug('Logout with invalid refresh token — treating as already logged out');
    await reply.code(200).send({ success: true });
    return;
  }

  if (tokenPayload.jti) {
    const ttlSeconds = getTokenRemainingTtl(refreshToken);
    if (ttlSeconds > 0) {
      try {
        const redis = getRedis();
        await redis.set(
          `blacklist:refresh:${tokenPayload.jti}`,
          '1',
          'EX',
          ttlSeconds,
        );
        logger.info(
          { userId: tokenPayload.userId, jti: tokenPayload.jti, ttlSeconds },
          'Refresh token blacklisted',
        );
      } catch (err) {
        logger.error({ err }, 'Redis error during logout blacklisting');
        // Fail gracefully — still return success
      }
    }
  }

  logger.info({ userId: tokenPayload.userId }, 'User logged out');
  await reply.code(200).send({ success: true });
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /auth/login — rate limited to 5 per IP per minute
  fastify.post('/auth/login', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
  }, loginHandler);

  // POST /auth/refresh
  fastify.post('/auth/refresh', {}, refreshHandler);

  // POST /auth/logout — requires valid access token
  fastify.post(
    '/auth/logout',
    {
      preHandler: authenticate,
    },
    logoutHandler,
  );
}
