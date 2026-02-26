import pino from 'pino';

const isDev = process.env['NODE_ENV'] === 'development';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
  redact: {
    paths: [
      'req.headers.authorization',
      '*.password',
      '*.accessToken',
      '*.refreshToken',
      '*.JWT_SECRET',
      '*.JWT_REFRESH_SECRET',
    ],
    censor: '[REDACTED]',
  },
  base: {
    service: 'management-api',
    pid: process.pid,
  },
});

export type Logger = typeof logger;
