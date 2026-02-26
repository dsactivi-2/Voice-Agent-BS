import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken } from '../auth/jwt.js';
import { logger } from '../utils/logger.js';

export interface AuthUser {
  userId: string;
  email: string;
  role: string;
}

// Extend FastifyRequest to include user
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/**
 * Fastify preHandler hook that verifies the Bearer access token
 * in the Authorization header and attaches the decoded user to request.user.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn({ path: request.url }, 'Missing or malformed Authorization header');
    await reply.code(401).send({
      error: 'Unauthorized',
      code: 'MISSING_TOKEN',
    });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = verifyAccessToken(token);
    request.user = payload;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.warn({ path: request.url, message }, 'Access token verification failed');
    await reply.code(401).send({
      error: 'Unauthorized',
      code: 'INVALID_TOKEN',
    });
  }
}

/**
 * Returns a Fastify preHandler hook that checks request.user.role
 * against the provided list of allowed roles.
 * Must be used after the `authenticate` hook.
 */
export function requireRole(roles: string[]) {
  return async function roleGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const user = request.user;

    if (!user) {
      await reply.code(401).send({
        error: 'Unauthorized',
        code: 'MISSING_TOKEN',
      });
      return;
    }

    if (!roles.includes(user.role)) {
      logger.warn(
        { userId: user.userId, role: user.role, requiredRoles: roles, path: request.url },
        'Insufficient role for route',
      );
      await reply.code(403).send({
        error: 'Forbidden',
        code: 'INSUFFICIENT_ROLE',
      });
    }
  };
}
