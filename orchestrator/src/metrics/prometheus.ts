import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from 'prom-client';
import type { FastifyInstance } from 'fastify';
import { logger } from '../utils/logger.js';

/**
 * Dedicated registry for this application's metrics.
 * Using a custom registry instead of the global default avoids
 * metric collision when the module is re-imported during tests.
 */
export const register = new Registry();

// Register default Node.js metrics (CPU, memory, event loop lag, GC, etc.)
collectDefaultMetrics({ register });

// ---------------------------------------------------------------------------
// Call metrics
// ---------------------------------------------------------------------------

export const callsTotal = new Counter({
  name: 'voice_calls_total',
  help: 'Total number of calls',
  labelNames: ['language', 'result', 'ab_group'] as const,
  registers: [register],
});

export const callDuration = new Histogram({
  name: 'voice_call_duration_seconds',
  help: 'Call duration in seconds',
  labelNames: ['language'] as const,
  buckets: [30, 60, 120, 180, 300, 600, 900],
  registers: [register],
});

export const activeCalls = new Gauge({
  name: 'voice_active_calls',
  help: 'Currently active calls',
  labelNames: ['language'] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Latency metrics
// ---------------------------------------------------------------------------

export const llmLatency = new Histogram({
  name: 'voice_llm_latency_ms',
  help: 'LLM response latency in milliseconds',
  labelNames: ['model', 'phase'] as const,
  buckets: [200, 500, 1000, 2000, 3000, 5000],
  registers: [register],
});

export const ttsLatency = new Histogram({
  name: 'voice_tts_latency_ms',
  help: 'TTS synthesis latency in milliseconds',
  labelNames: ['language'] as const,
  buckets: [100, 200, 500, 1000, 2000],
  registers: [register],
});

export const asrLatency = new Histogram({
  name: 'voice_asr_latency_ms',
  help: 'ASR processing latency in milliseconds',
  labelNames: ['language'] as const,
  buckets: [100, 200, 500, 1000],
  registers: [register],
});

export const e2eLatency = new Histogram({
  name: 'voice_e2e_latency_ms',
  help: 'End-to-end turn latency in milliseconds',
  labelNames: ['language', 'llm_mode'] as const,
  buckets: [500, 1000, 1500, 2000, 3000, 5000],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Error metrics
// ---------------------------------------------------------------------------

export const errorsTotal = new Counter({
  name: 'voice_errors_total',
  help: 'Total errors',
  labelNames: ['service', 'type'] as const,
  registers: [register],
});

export const llmSwitches = new Counter({
  name: 'voice_llm_switches_total',
  help: 'LLM mode switches',
  labelNames: ['from_mode', 'to_mode'] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Memory / cache metrics
// ---------------------------------------------------------------------------

export const memorySummaryGenerations = new Counter({
  name: 'voice_memory_summary_generations_total',
  help: 'Memory summary generation count',
  registers: [register],
});

export const ttsCacheHits = new Counter({
  name: 'voice_tts_cache_hits_total',
  help: 'TTS cache hit count',
  registers: [register],
});

export const ttsCacheMisses = new Counter({
  name: 'voice_tts_cache_misses_total',
  help: 'TTS cache miss count',
  registers: [register],
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers GET /metrics on the given Fastify instance.
 * Returns Prometheus text format with the correct content-type header.
 */
export function registerMetricsRoute(app: FastifyInstance): void {
  app.get('/metrics', async (_request, reply) => {
    try {
      const output = await register.metrics();
      await reply
        .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
        .send(output);
    } catch (err) {
      logger.error({ err }, 'Failed to collect Prometheus metrics');
      await reply.status(500).send('Internal Server Error');
    }
  });
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * Resets all metric values in the registry.
 * Intended for use in unit tests only.
 */
export function resetMetrics(): void {
  register.resetMetrics();
}
