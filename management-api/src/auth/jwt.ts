import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export interface AccessTokenPayload {
  userId: string;
  email: string;
  role: string;
}

export interface RefreshTokenPayload {
  userId: string;
}

interface RawAccessToken {
  userId: string;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

interface RawRefreshToken {
  userId: string;
  iat?: number;
  exp?: number;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
  });
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(payload, config.JWT_REFRESH_SECRET, {
    expiresIn: config.JWT_REFRESH_TTL as jwt.SignOptions['expiresIn'],
    jwtid: crypto.randomUUID(),
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  let decoded: jwt.JwtPayload | string;
  try {
    decoded = jwt.verify(token, config.JWT_SECRET);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new Error('Access token expired');
    }
    if (err instanceof jwt.JsonWebTokenError) {
      throw new Error('Invalid access token');
    }
    throw new Error('Token verification failed');
  }

  if (typeof decoded === 'string' || decoded === null) {
    throw new Error('Invalid access token payload');
  }

  const raw = decoded as RawAccessToken;

  if (
    typeof raw.userId !== 'string' ||
    typeof raw.email !== 'string' ||
    typeof raw.role !== 'string'
  ) {
    throw new Error('Access token missing required fields');
  }

  return { userId: raw.userId, email: raw.email, role: raw.role };
}

export function verifyRefreshToken(token: string): RefreshTokenPayload & { jti?: string } {
  let decoded: jwt.JwtPayload | string;
  try {
    decoded = jwt.verify(token, config.JWT_REFRESH_SECRET);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new Error('Refresh token expired');
    }
    if (err instanceof jwt.JsonWebTokenError) {
      throw new Error('Invalid refresh token');
    }
    throw new Error('Token verification failed');
  }

  if (typeof decoded === 'string' || decoded === null) {
    throw new Error('Invalid refresh token payload');
  }

  const raw = decoded as RawRefreshToken & { jti?: string };

  if (typeof raw.userId !== 'string') {
    throw new Error('Refresh token missing userId');
  }

  return { userId: raw.userId, jti: raw.jti };
}

/**
 * Returns the number of seconds remaining until the token expires.
 * Returns 0 if the token is already expired or has no exp claim.
 */
export function getTokenRemainingTtl(token: string): number {
  try {
    const decoded = jwt.decode(token);
    if (typeof decoded === 'string' || decoded === null || decoded.exp === undefined) {
      return 0;
    }
    const remaining = decoded.exp - Math.floor(Date.now() / 1000);
    return Math.max(0, remaining);
  } catch {
    return 0;
  }
}
