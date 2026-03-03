"""
Voice Agent Auto-Fix Monitor — Prometheus collector.

Queries Prometheus for TTS cache metrics and other voice agent metrics.
"""

from __future__ import annotations

import logging
from typing import Any

import requests

from config import PROMETHEUS_URL

log = logging.getLogger("monitor.collectors.prometheus")


def _query(promql: str) -> float | None:
    """Execute a PromQL instant query and return the scalar value."""
    try:
        resp = requests.get(
            f"{PROMETHEUS_URL}/api/v1/query",
            params={"query": promql},
            timeout=5,
        )
        if not resp.ok:
            log.warning("Prometheus query failed (HTTP %d): %s", resp.status_code, promql)
            return None

        data = resp.json()
        results = data.get("data", {}).get("result", [])
        if not results:
            return 0.0
        # Return the first result's value
        return float(results[0]["value"][1])
    except (requests.RequestException, ValueError, KeyError, IndexError) as exc:
        log.warning("Prometheus query error for '%s': %s", promql, exc)
        return None


def collect() -> dict[str, Any]:
    """Collect key metrics from Prometheus."""
    result: dict[str, Any] = {}

    # TTS cache miss rate (per minute over the last 5 minutes)
    tts_miss_rate = _query(
        'rate(voice_tts_cache_misses_total[5m]) * 60'
    )
    result["tts_cache_miss_per_min"] = tts_miss_rate

    # TTS cache hit rate for context
    tts_hit_rate = _query(
        'rate(voice_tts_cache_hits_total[5m]) * 60'
    )
    result["tts_cache_hit_per_min"] = tts_hit_rate

    # Active calls gauge
    active_calls = _query('voice_active_calls')
    result["active_calls"] = active_calls

    # Error rate (per minute)
    error_rate = _query(
        'rate(voice_errors_total[5m]) * 60'
    )
    result["error_rate_per_min"] = error_rate

    # E2E latency P95 (histogram if available)
    latency_p95 = _query(
        'histogram_quantile(0.95, rate(voice_e2e_latency_ms_bucket[5m]))'
    )
    result["latency_p95_ms"] = latency_p95

    return result
