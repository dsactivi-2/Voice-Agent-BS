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
      '*.apiKey',
      '*.password',
      '*.POSTGRES_PASSWORD',
      '*.OPENAI_API_KEY',
      '*.DEEPGRAM_API_KEY',
      '*.AZURE_SPEECH_KEY',
      '*.TELNYX_API_KEY',
    ],
    censor: '[REDACTED]',
  },
  base: {
    service: 'voice-orchestrator',
    pid: process.pid,
  },
});

export type Logger = typeof logger;
