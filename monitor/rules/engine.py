"""
Voice Agent Auto-Fix Monitor — Rules engine.

Deterministic rules (no LLM) that analyze collected data and return
a list of triggered alerts with tier, description, and suggested fix.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from config import (
    RULE_CLARIFICATION_LOOP_COUNT,
    RULE_ERROR_RATE_PCT,
    RULE_HEALTH_CONSECUTIVE_FAILURES,
    RULE_INTRO_REPEAT_PCT,
    RULE_LATENCY_P95_MS,
    RULE_MIN_AVG_TURNS,
    RULE_REJECTION_RATE_PCT,
    RULE_STUCK_CALL_MINUTES,
    RULE_TTS_CACHE_MISS_PER_MIN,
)

log = logging.getLogger("monitor.rules")


@dataclass
class Alert:
    """A triggered detection rule."""
    rule: str
    tier: int          # 1=auto-fix silent, 2=auto-fix+email, 3=alert only
    fix_type: str      # Action to take (e.g. 'container_restart', 'alert_only')
    description: str
    value: Any = None  # The actual measured value
    threshold: Any = None  # The threshold that was exceeded


def evaluate(
    db_data: dict[str, Any],
    docker_data: dict[str, Any],
    health_data: dict[str, Any],
    prometheus_data: dict[str, Any],
    state: dict[str, Any],
) -> list[Alert]:
    """Run all detection rules against collected data. Return list of alerts."""
    alerts: list[Alert] = []

    # Skip DB-based rules if we have no DB data
    has_db = "error" not in db_data

    if has_db:
        _check_intro_repeat(db_data, alerts)
        _check_clarification_loop(db_data, alerts)
        _check_rejection_rate(db_data, alerts)
        _check_avg_turns(db_data, alerts)
        _check_latency_p95(db_data, alerts)
        _check_error_rate(db_data, alerts)
        _check_stuck_calls(db_data, alerts)

    _check_tts_cache_miss(prometheus_data, alerts)
    _check_container_health(docker_data, alerts)
    _check_health_api(health_data, state, alerts)
    _check_external_services(health_data, alerts)

    if alerts:
        log.info("Rules triggered %d alert(s)", len(alerts))
        for a in alerts:
            log.info("  [Tier %d] %s: %s (value=%s, threshold=%s)",
                     a.tier, a.rule, a.description, a.value, a.threshold)
    else:
        log.info("All rules passed — no alerts")

    return alerts


# ---------------------------------------------------------------------------
# Individual rules
# ---------------------------------------------------------------------------

def _check_intro_repeat(db: dict, alerts: list[Alert]) -> None:
    intro = db.get("intro_repeat", {})
    pct = intro.get("pct", 0)
    if pct > RULE_INTRO_REPEAT_PCT:
        alerts.append(Alert(
            rule="intro_repeat",
            tier=2,
            fix_type="container_restart",
            description=f"Intro repeated in {pct:.1f}% of calls (threshold: {RULE_INTRO_REPEAT_PCT}%)",
            value=pct,
            threshold=RULE_INTRO_REPEAT_PCT,
        ))


def _check_clarification_loop(db: dict, alerts: list[Alert]) -> None:
    count = db.get("clarification_loops", 0)
    if count > RULE_CLARIFICATION_LOOP_COUNT:
        alerts.append(Alert(
            rule="clarification_loop",
            tier=2,
            fix_type="container_restart",
            description=f"{count} calls with clarification loops (threshold: {RULE_CLARIFICATION_LOOP_COUNT})",
            value=count,
            threshold=RULE_CLARIFICATION_LOOP_COUNT,
        ))


def _check_rejection_rate(db: dict, alerts: list[Alert]) -> None:
    calls_2h = db.get("calls_2h", {})
    pct = calls_2h.get("rejection_rate_pct") or 0
    total = calls_2h.get("total_calls", 0)
    # Only trigger if we have enough data (at least 5 calls)
    if total >= 5 and pct > RULE_REJECTION_RATE_PCT:
        alerts.append(Alert(
            rule="high_rejection_rate",
            tier=3,
            fix_type="alert_only",
            description=f"Rejection rate {pct:.1f}% over 2h ({total} calls, threshold: {RULE_REJECTION_RATE_PCT}%)",
            value=pct,
            threshold=RULE_REJECTION_RATE_PCT,
        ))


def _check_avg_turns(db: dict, alerts: list[Alert]) -> None:
    calls_1h = db.get("calls_1h", {})
    avg = float(calls_1h.get("avg_turn_count", 0) or 0)
    total = calls_1h.get("total_calls", 0)
    # Only trigger with enough data
    if total >= 5 and avg < RULE_MIN_AVG_TURNS and avg > 0:
        alerts.append(Alert(
            rule="low_avg_turns",
            tier=2,
            fix_type="alert_only",
            description=f"Average turns {avg:.1f} (threshold: {RULE_MIN_AVG_TURNS}, {total} calls)",
            value=avg,
            threshold=RULE_MIN_AVG_TURNS,
        ))


def _check_latency_p95(db: dict, alerts: list[Alert]) -> None:
    p95 = db.get("latency_p95_ms", 0)
    if p95 > RULE_LATENCY_P95_MS:
        alerts.append(Alert(
            rule="high_latency_p95",
            tier=2,
            fix_type="container_restart",
            description=f"E2E latency P95 = {p95:.0f}ms (threshold: {RULE_LATENCY_P95_MS}ms)",
            value=p95,
            threshold=RULE_LATENCY_P95_MS,
        ))


def _check_error_rate(db: dict, alerts: list[Alert]) -> None:
    calls_1h = db.get("calls_1h", {})
    pct = calls_1h.get("error_rate_pct") or 0
    total = calls_1h.get("total_calls", 0)
    if total >= 3 and pct > RULE_ERROR_RATE_PCT:
        alerts.append(Alert(
            rule="high_error_rate",
            tier=2,
            fix_type="container_restart",
            description=f"Error rate {pct:.1f}% in last hour ({total} calls, threshold: {RULE_ERROR_RATE_PCT}%)",
            value=pct,
            threshold=RULE_ERROR_RATE_PCT,
        ))


def _check_stuck_calls(db: dict, alerts: list[Alert]) -> None:
    stuck = db.get("stuck_calls", 0)
    if stuck > 0:
        alerts.append(Alert(
            rule="stuck_calls",
            tier=1,
            fix_type="container_restart",
            description=f"{stuck} call(s) stuck (no ended_at for >{RULE_STUCK_CALL_MINUTES}min)",
            value=stuck,
            threshold=0,
        ))


def _check_tts_cache_miss(prom: dict, alerts: list[Alert]) -> None:
    miss_rate = prom.get("tts_cache_miss_per_min")
    if miss_rate is not None and miss_rate > RULE_TTS_CACHE_MISS_PER_MIN:
        alerts.append(Alert(
            rule="tts_cache_miss",
            tier=1,
            fix_type="container_restart",
            description=f"TTS cache miss rate {miss_rate:.1f}/min (threshold: {RULE_TTS_CACHE_MISS_PER_MIN}/min)",
            value=miss_rate,
            threshold=RULE_TTS_CACHE_MISS_PER_MIN,
        ))


def _check_container_health(docker: dict, alerts: list[Alert]) -> None:
    orch = docker.get("orchestrator", {})
    health = orch.get("health", "unknown")
    status = orch.get("status", "unknown")

    if status == "not_found":
        alerts.append(Alert(
            rule="container_not_found",
            tier=1,
            fix_type="container_restart",
            description="Orchestrator container not found",
            value=status,
        ))
    elif health == "unhealthy":
        alerts.append(Alert(
            rule="container_unhealthy",
            tier=1,
            fix_type="container_restart",
            description=f"Orchestrator container unhealthy (status={status})",
            value=health,
        ))


def _check_health_api(health: dict, state: dict, alerts: list[Alert]) -> None:
    if not health.get("reachable"):
        # Track consecutive failures in state
        from state import increment_failure
        count = increment_failure(state, "health_api")
        if count >= RULE_HEALTH_CONSECUTIVE_FAILURES:
            alerts.append(Alert(
                rule="health_api_down",
                tier=1,
                fix_type="container_restart",
                description=f"Health API unreachable {count} consecutive times",
                value=count,
                threshold=RULE_HEALTH_CONSECUTIVE_FAILURES,
            ))
    else:
        from state import reset_failure
        reset_failure(state, "health_api")


def _check_external_services(health: dict, alerts: list[Alert]) -> None:
    services = health.get("services", {})
    if not services:
        return

    for svc_name, svc_data in services.items():
        # Check if service is unhealthy
        status = svc_data if isinstance(svc_data, str) else svc_data.get("status", "unknown")
        if status in ("unhealthy", "error", "down", "disconnected"):
            alerts.append(Alert(
                rule=f"external_service_{svc_name}",
                tier=3,
                fix_type="alert_only",
                description=f"External service '{svc_name}' is {status}",
                value=status,
            ))
