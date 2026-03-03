#!/usr/bin/env python3
"""
Voice Agent Auto-Fix Monitor — Main entry point.

Orchestrates the collect → analyze → fix → verify → report loop.
Designed to run as a one-shot process via systemd timer (every 5 minutes).

Usage:
    python monitor.py              # Normal run
    python monitor.py --dry-run    # Collect + analyze only, no fixes applied
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from datetime import datetime, timezone
from typing import Any

# Setup logging before imports that use it
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("monitor")

import config
import state as state_mod
import safety
from collectors import db, docker, health, prometheus
from rules.engine import evaluate, Alert
from actions.executor import execute_fix
from actions.notify import send_alert, send_budget_exhausted


def main() -> int:
    parser = argparse.ArgumentParser(description="Voice Agent Auto-Fix Monitor")
    parser.add_argument("--dry-run", action="store_true",
                        help="Collect and analyze only, do not apply fixes")
    args = parser.parse_args()

    start = time.monotonic()
    log.info("=" * 60)
    log.info("Voice Monitor run started (dry_run=%s)", args.dry_run)
    log.info("=" * 60)

    # --- Load state ---
    st = state_mod.load()
    safety.prune_old_fixes(st)

    # --- Collect ---
    log.info("Phase 1: Collecting data...")

    db_data = _safe_collect("db", db.collect)
    docker_data = _safe_collect("docker", docker.collect)
    health_data = _safe_collect("health", health.collect)
    prom_data = _safe_collect("prometheus", prometheus.collect)

    log.info("Collection complete: db=%s, docker=%s, health=%s, prometheus=%s",
             "ok" if "error" not in db_data else "error",
             "ok" if docker_data else "empty",
             "ok" if health_data.get("reachable") else "unreachable",
             "ok" if prom_data else "empty")

    # --- Analyze ---
    log.info("Phase 2: Evaluating rules...")
    alerts = evaluate(db_data, docker_data, health_data, prom_data, st)

    if not alerts:
        log.info("No alerts triggered. System healthy.")
        state_mod.save(st)
        elapsed = time.monotonic() - start
        log.info("Run completed in %.1fs", elapsed)
        return 0

    # --- Fix + Verify + Report ---
    log.info("Phase 3: Processing %d alert(s)...", len(alerts))

    # Sort by tier (lowest first = most critical)
    alerts.sort(key=lambda a: a.tier)

    applied_count = 0
    for alert in alerts:
        log.info("Processing: [Tier %d] %s — %s", alert.tier, alert.rule, alert.description)

        # Check if budget exhausted before each fix
        if alert.tier < 3 and not safety.can_fix(st):
            log.warning("Fix budget exhausted, sending escalation alert")
            send_budget_exhausted(st)
            # Still notify about this alert but mark as not fixable
            result = {"applied": False, "reason": "fix_budget_exhausted", "verified": False}
            send_alert(alert, result)
            continue

        result = execute_fix(alert, st, dry_run=args.dry_run)

        if result["applied"]:
            applied_count += 1
            log.info("Fix applied for '%s': verified=%s", alert.rule, result["verified"])
        else:
            log.info("Fix not applied for '%s': reason=%s", alert.rule, result["reason"])

        # Send notification for Tier 2+ (always) and Tier 1 (only if fix failed)
        if alert.tier >= 2 or (alert.tier == 1 and not result.get("verified", False) and result["applied"]):
            send_alert(alert, result)

    # --- Save state ---
    state_mod.save(st)

    elapsed = time.monotonic() - start
    log.info("=" * 60)
    log.info("Run completed in %.1fs: %d alert(s), %d fix(es) applied",
             elapsed, len(alerts), applied_count)
    log.info("=" * 60)
    return 0


def _safe_collect(name: str, func) -> dict[str, Any]:
    """Run a collector with error handling."""
    try:
        return func()
    except Exception as exc:
        log.error("Collector '%s' failed: %s", name, exc)
        return {"error": str(exc)}


if __name__ == "__main__":
    sys.exit(main())
