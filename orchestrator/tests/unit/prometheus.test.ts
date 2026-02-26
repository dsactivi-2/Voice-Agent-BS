import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  callsTotal,
  activeCalls,
  llmLatency,
  e2eLatency,
  errorsTotal,
  llmSwitches,
  memorySummaryGenerations,
  ttsCacheHits,
  ttsCacheMisses,
  callDuration,
  ttsLatency,
  asrLatency,
  registerMetricsRoute,
  resetMetrics,
  register,
} from '../../src/metrics/prometheus.js';

// Reset all counters / gauges / histograms before each test so tests are
// fully isolated from one another and from module-level side effects.
beforeEach(() => {
  resetMetrics();
});

// ---------------------------------------------------------------------------
// callsTotal
// ---------------------------------------------------------------------------

describe('callsTotal', () => {
  it('increments by 1 with labels', async () => {
    callsTotal.inc({ language: 'bs-BA', result: 'success', ab_group: 'mini_only' });

    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'voice_calls_total');
    expect(metric).toBeDefined();

    const value = (metric?.values as Array<{ labels: Record<string, string>; value: number }>).find(
      (v) =>
        v.labels['language'] === 'bs-BA' &&
        v.labels['result'] === 'success' &&
        v.labels['ab_group'] === 'mini_only',
    );
    expect(value?.value).toBe(1);
  });

  it('accumulates multiple increments', async () => {
    callsTotal.inc({ language: 'sr-RS', result: 'no_answer', ab_group: 'full_only' });
    callsTotal.inc({ language: 'sr-RS', result: 'no_answer', ab_group: 'full_only' });
    callsTotal.inc({ language: 'sr-RS', result: 'no_answer', ab_group: 'full_only' });

    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'voice_calls_total');
    const value = (metric?.values as Array<{ labels: Record<string, string>; value: number }>).find(
      (v) =>
        v.labels['language'] === 'sr-RS' &&
        v.labels['result'] === 'no_answer' &&
        v.labels['ab_group'] === 'full_only',
    );
    expect(value?.value).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// activeCalls
// ---------------------------------------------------------------------------

describe('activeCalls', () => {
  it('increases and decreases correctly', async () => {
    activeCalls.inc({ language: 'bs-BA' });
    activeCalls.inc({ language: 'bs-BA' });
    activeCalls.dec({ language: 'bs-BA' });

    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'voice_active_calls');
    const value = (metric?.values as Array<{ labels: Record<string, string>; value: number }>).find(
      (v) => v.labels['language'] === 'bs-BA',
    );
    expect(value?.value).toBe(1);
  });

  it('can be set to an explicit value', async () => {
    activeCalls.set({ language: 'sr-RS' }, 7);

    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'voice_active_calls');
    const value = (metric?.values as Array<{ labels: Record<string, string>; value: number }>).find(
      (v) => v.labels['language'] === 'sr-RS',
    );
    expect(value?.value).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// llmLatency
// ---------------------------------------------------------------------------

describe('llmLatency', () => {
  it('records an observed value in the correct bucket', async () => {
    llmLatency.observe({ model: 'gpt-4o-mini', phase: 'hook' }, 450);

    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'voice_llm_latency_ms');
    expect(metric).toBeDefined();

    // The sum should equal the single observed value
    const sumEntry = (
      metric?.values as Array<{ labels: Record<string, string>; metricName?: string; value: number }>
    ).find(
      (v) =>
        v.metricName === 'voice_llm_latency_ms_sum' &&
        v.labels['model'] === 'gpt-4o-mini' &&
        v.labels['phase'] === 'hook',
    );
    expect(sumEntry?.value).toBe(450);
  });

  it('increments count for each observation', async () => {
    llmLatency.observe({ model: 'gpt-4o', phase: 'pitch' }, 800);
    llmLatency.observe({ model: 'gpt-4o', phase: 'pitch' }, 1200);

    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'voice_llm_latency_ms');
    const countEntry = (
      metric?.values as Array<{ labels: Record<string, string>; metricName?: string; value: number }>
    ).find(
      (v) =>
        v.metricName === 'voice_llm_latency_ms_count' &&
        v.labels['model'] === 'gpt-4o' &&
        v.labels['phase'] === 'pitch',
    );
    expect(countEntry?.value).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// e2eLatency
// ---------------------------------------------------------------------------

describe('e2eLatency', () => {
  it('records with correct language and llm_mode labels', async () => {
    e2eLatency.observe({ language: 'bs-BA', llm_mode: 'mini' }, 950);

    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'voice_e2e_latency_ms');
    expect(metric).toBeDefined();

    const sumEntry = (
      metric?.values as Array<{ labels: Record<string, string>; metricName?: string; value: number }>
    ).find(
      (v) =>
        v.metricName === 'voice_e2e_latency_ms_sum' &&
        v.labels['language'] === 'bs-BA' &&
        v.labels['llm_mode'] === 'mini',
    );
    expect(sumEntry?.value).toBe(950);
  });
});

// ---------------------------------------------------------------------------
// errorsTotal
// ---------------------------------------------------------------------------

describe('errorsTotal', () => {
  it('counts errors correctly per service and type', async () => {
    errorsTotal.inc({ service: 'llm', type: 'timeout' });
    errorsTotal.inc({ service: 'llm', type: 'timeout' });
    errorsTotal.inc({ service: 'tts', type: 'synthesis_failed' });

    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'voice_errors_total');
    const values = metric?.values as Array<{ labels: Record<string, string>; value: number }>;

    const llmTimeout = values.find(
      (v) => v.labels['service'] === 'llm' && v.labels['type'] === 'timeout',
    );
    const ttsFail = values.find(
      (v) => v.labels['service'] === 'tts' && v.labels['type'] === 'synthesis_failed',
    );

    expect(llmTimeout?.value).toBe(2);
    expect(ttsFail?.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// llmSwitches
// ---------------------------------------------------------------------------

describe('llmSwitches', () => {
  it('records mode switch from mini to full', async () => {
    llmSwitches.inc({ from_mode: 'mini', to_mode: 'full' });

    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'voice_llm_switches_total');
    const value = (metric?.values as Array<{ labels: Record<string, string>; value: number }>).find(
      (v) => v.labels['from_mode'] === 'mini' && v.labels['to_mode'] === 'full',
    );
    expect(value?.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// memorySummaryGenerations / TTS cache
// ---------------------------------------------------------------------------

describe('memory and cache metrics', () => {
  it('increments memorySummaryGenerations', async () => {
    memorySummaryGenerations.inc();
    memorySummaryGenerations.inc();

    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'voice_memory_summary_generations_total');
    const total = (metric?.values as Array<{ value: number }>).reduce(
      (sum, v) => sum + v.value,
      0,
    );
    expect(total).toBe(2);
  });

  it('tracks tts cache hits and misses separately', async () => {
    ttsCacheHits.inc();
    ttsCacheHits.inc();
    ttsCacheHits.inc();
    ttsCacheMisses.inc();

    const metrics = await register.getMetricsAsJSON();

    const hitsMetric = metrics.find((m) => m.name === 'voice_tts_cache_hits_total');
    const missesMetric = metrics.find((m) => m.name === 'voice_tts_cache_misses_total');

    const hitsTotal = (hitsMetric?.values as Array<{ value: number }>).reduce(
      (sum, v) => sum + v.value,
      0,
    );
    const missesTotal = (missesMetric?.values as Array<{ value: number }>).reduce(
      (sum, v) => sum + v.value,
      0,
    );

    expect(hitsTotal).toBe(3);
    expect(missesTotal).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// registerMetricsRoute — HTTP endpoint
// ---------------------------------------------------------------------------

describe('registerMetricsRoute', () => {
  it('returns 200 with text/plain content-type on GET /metrics', async () => {
    const app = Fastify();
    registerMetricsRoute(app);

    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
  });

  it('response body contains Prometheus exposition format markers', async () => {
    // Observe a value so the output is non-trivial
    callsTotal.inc({ language: 'bs-BA', result: 'success', ab_group: 'mini_only' });

    const app = Fastify();
    registerMetricsRoute(app);

    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.body).toContain('# HELP');
    expect(response.body).toContain('# TYPE');
    expect(response.body).toContain('voice_calls_total');
  });

  it('exposes all registered custom metric names', async () => {
    const app = Fastify();
    registerMetricsRoute(app);

    const response = await app.inject({ method: 'GET', url: '/metrics' });
    const body = response.body;

    expect(body).toContain('voice_calls_total');
    expect(body).toContain('voice_call_duration_seconds');
    expect(body).toContain('voice_active_calls');
    expect(body).toContain('voice_llm_latency_ms');
    expect(body).toContain('voice_tts_latency_ms');
    expect(body).toContain('voice_asr_latency_ms');
    expect(body).toContain('voice_e2e_latency_ms');
    expect(body).toContain('voice_errors_total');
    expect(body).toContain('voice_llm_switches_total');
    expect(body).toContain('voice_memory_summary_generations_total');
    expect(body).toContain('voice_tts_cache_hits_total');
    expect(body).toContain('voice_tts_cache_misses_total');
  });
});

// ---------------------------------------------------------------------------
// resetMetrics
// ---------------------------------------------------------------------------

describe('resetMetrics', () => {
  it('clears counter values back to zero after reset', async () => {
    callsTotal.inc({ language: 'bs-BA', result: 'success', ab_group: 'mini_only' });
    callsTotal.inc({ language: 'bs-BA', result: 'success', ab_group: 'mini_only' });
    errorsTotal.inc({ service: 'asr', type: 'decode_error' });

    // Verify non-zero before reset
    let metrics = await register.getMetricsAsJSON();
    let callsMetric = metrics.find((m) => m.name === 'voice_calls_total');
    let preResetValue = (
      callsMetric?.values as Array<{ labels: Record<string, string>; value: number }>
    ).find(
      (v) =>
        v.labels['language'] === 'bs-BA' &&
        v.labels['result'] === 'success' &&
        v.labels['ab_group'] === 'mini_only',
    );
    expect(preResetValue?.value).toBe(2);

    resetMetrics();

    // After reset, the label combination should no longer appear
    metrics = await register.getMetricsAsJSON();
    callsMetric = metrics.find((m) => m.name === 'voice_calls_total');
    const postResetValues = (
      callsMetric?.values as Array<{ labels: Record<string, string>; value: number }>
    ) ?? [];
    const found = postResetValues.find(
      (v) =>
        v.labels['language'] === 'bs-BA' &&
        v.labels['result'] === 'success' &&
        v.labels['ab_group'] === 'mini_only',
    );
    expect(found).toBeUndefined();
  });

  it('allows metrics to be incremented again after reset', async () => {
    // First observation cycle
    activeCalls.inc({ language: 'sr-RS' });
    activeCalls.inc({ language: 'sr-RS' });

    resetMetrics();

    // Second cycle — should start from zero
    activeCalls.inc({ language: 'sr-RS' });

    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'voice_active_calls');
    const value = (metric?.values as Array<{ labels: Record<string, string>; value: number }>).find(
      (v) => v.labels['language'] === 'sr-RS',
    );
    expect(value?.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Additional coverage: callDuration, ttsLatency, asrLatency
// ---------------------------------------------------------------------------

describe('remaining histograms', () => {
  it('callDuration records observation correctly', async () => {
    callDuration.observe({ language: 'bs-BA' }, 90);

    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'voice_call_duration_seconds');
    const sumEntry = (
      metric?.values as Array<{ labels: Record<string, string>; metricName?: string; value: number }>
    ).find(
      (v) =>
        v.metricName === 'voice_call_duration_seconds_sum' && v.labels['language'] === 'bs-BA',
    );
    expect(sumEntry?.value).toBe(90);
  });

  it('ttsLatency records observation correctly', async () => {
    ttsLatency.observe({ language: 'sr-RS' }, 300);

    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'voice_tts_latency_ms');
    const sumEntry = (
      metric?.values as Array<{ labels: Record<string, string>; metricName?: string; value: number }>
    ).find(
      (v) => v.metricName === 'voice_tts_latency_ms_sum' && v.labels['language'] === 'sr-RS',
    );
    expect(sumEntry?.value).toBe(300);
  });

  it('asrLatency records observation correctly', async () => {
    asrLatency.observe({ language: 'bs-BA' }, 150);

    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'voice_asr_latency_ms');
    const sumEntry = (
      metric?.values as Array<{ labels: Record<string, string>; metricName?: string; value: number }>
    ).find(
      (v) => v.metricName === 'voice_asr_latency_ms_sum' && v.labels['language'] === 'bs-BA',
    );
    expect(sumEntry?.value).toBe(150);
  });
});
