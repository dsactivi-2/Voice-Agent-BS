"""
Voice Agent Auto-Fix Monitor — Fix executor.

Applies auto-fixes for Tier 1 and Tier 2 alerts.
All fixes go through the safety layer first.
"""

from __future__ import annotations

import logging
from typing import Any

import state as state_mod
import safety
from rules.engine import Alert

log = logging.getLogger("monitor.actions.executor")


def execute_fix(alert: Alert, st: dict[str, Any], dry_run: bool = False) -> dict[str, Any]:
    """
    Attempt to fix an alert. Returns a result dict with:
      - applied: bool
      - reason: str (why it was/wasn't applied)
      - verified: bool (health check after fix)
    """
    fix_type = alert.fix_type

    # Tier 3 = alert only, never auto-fix
    if alert.tier >= 3:
        return {"applied": False, "reason": "tier_3_alert_only", "verified": False}

    # Safety: rate limit check
    if not safety.can_fix(st):
        return {"applied": False, "reason": "fix_budget_exhausted", "verified": False}

    # Safety: cooldown check
    if safety.is_on_cooldown(st, fix_type):
        return {"applied": False, "reason": f"cooldown_active_{fix_type}", "verified": False}

    if dry_run:
        log.info("[DRY RUN] Would execute fix: %s for alert: %s", fix_type, alert.rule)
        return {"applied": False, "reason": "dry_run", "verified": False}

    # Execute the fix
    log.info("Executing fix '%s' for alert '%s'", fix_type, alert.rule)

    success = False
    if fix_type == "container_restart":
        success = _do_container_restart()
    else:
        log.warning("Unknown fix type: %s", fix_type)
        return {"applied": False, "reason": f"unknown_fix_type_{fix_type}", "verified": False}

    if not success:
        return {"applied": False, "reason": "fix_execution_failed", "verified": False}

    # Record the fix in state
    state_mod.record_fix(st, fix_type, alert.rule)

    # Verify health after fix
    verified = safety.verify_health()
    if not verified:
        log.error("Health verification failed after fix '%s'", fix_type)

    return {"applied": True, "reason": "success", "verified": verified}


def _do_container_restart() -> bool:
    """Restart the orchestrator container with health verification."""
    log.info("Performing container restart...")
    return safety.restart_container()
