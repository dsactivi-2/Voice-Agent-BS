"""
Voice Agent Auto-Fix Monitor — Safety layer.

Enforces rate limits, cooldowns, .env snapshots, and rollback
to prevent runaway auto-fixes from making things worse.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

import requests

from config import (
    COOLDOWN_MINUTES,
    COMPOSE_FILE,
    HEALTH_URL,
    HEALTH_VERIFY_POLL_SEC,
    HEALTH_VERIFY_TIMEOUT_SEC,
    MAX_FIXES_PER_HOUR,
    VOICE_ENV_FILE,
    VOICE_SYSTEM_DIR,
    DATA_DIR,
)

log = logging.getLogger("monitor.safety")


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------

def prune_old_fixes(state: dict[str, Any]) -> None:
    """Remove fixes older than 1 hour from the rolling window."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
    original = state.get("fixes_this_hour", [])
    pruned = []
    for fix in original:
        try:
            fix_time = datetime.fromisoformat(fix["at"])
            if fix_time.tzinfo is None:
                fix_time = fix_time.replace(tzinfo=timezone.utc)
            if fix_time > cutoff:
                pruned.append(fix)
        except (KeyError, ValueError):
            continue
    state["fixes_this_hour"] = pruned


def can_fix(state: dict[str, Any]) -> bool:
    """Check if we're under the hourly fix budget."""
    prune_old_fixes(state)
    count = len(state.get("fixes_this_hour", []))
    if count >= MAX_FIXES_PER_HOUR:
        log.warning(
            "Fix budget exhausted: %d/%d fixes in the last hour",
            count, MAX_FIXES_PER_HOUR,
        )
        return False
    return True


def is_on_cooldown(state: dict[str, Any], fix_type: str) -> bool:
    """Check if a specific fix type is still in cooldown."""
    last_str = state.get("cooldowns", {}).get(fix_type)
    if not last_str:
        return False
    try:
        last_time = datetime.fromisoformat(last_str)
        if last_time.tzinfo is None:
            last_time = last_time.replace(tzinfo=timezone.utc)
        cooldown_until = last_time + timedelta(minutes=COOLDOWN_MINUTES)
        if datetime.now(timezone.utc) < cooldown_until:
            remaining = (cooldown_until - datetime.now(timezone.utc)).total_seconds()
            log.info(
                "Fix '%s' on cooldown for %d more seconds",
                fix_type, int(remaining),
            )
            return True
    except (ValueError, TypeError):
        pass
    return False


# ---------------------------------------------------------------------------
# .env snapshot and rollback
# ---------------------------------------------------------------------------

def snapshot_env() -> Path | None:
    """Take a timestamped backup of .env. Returns backup path."""
    if not VOICE_ENV_FILE.exists():
        log.error("Cannot snapshot: %s does not exist", VOICE_ENV_FILE)
        return None
    backup_dir = DATA_DIR / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = backup_dir / f".env.{ts}.bak"
    shutil.copy2(VOICE_ENV_FILE, backup_path)
    log.info("Snapshot: %s → %s", VOICE_ENV_FILE, backup_path)
    return backup_path


def rollback_env(backup_path: Path) -> bool:
    """Restore .env from a snapshot and restart the container."""
    if not backup_path.exists():
        log.error("Rollback failed: backup %s not found", backup_path)
        return False
    shutil.copy2(backup_path, VOICE_ENV_FILE)
    log.warning("Rolled back .env from %s", backup_path)
    restart_container()
    return True


# ---------------------------------------------------------------------------
# Container operations
# ---------------------------------------------------------------------------

def restart_container() -> bool:
    """Restart the orchestrator container via docker compose."""
    log.info("Restarting orchestrator container...")
    try:
        subprocess.run(
            ["docker", "compose", "-f", str(COMPOSE_FILE), "restart", "orchestrator"],
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        log.info("Container restart command succeeded")
        return True
    except subprocess.CalledProcessError as exc:
        log.error("Container restart failed: %s", exc.stderr)
        return False
    except subprocess.TimeoutExpired:
        log.error("Container restart timed out after 60s")
        return False


def verify_health() -> bool:
    """Poll /health until it returns 200 or timeout."""
    deadline = time.monotonic() + HEALTH_VERIFY_TIMEOUT_SEC
    log.info("Verifying health (timeout=%ds)...", HEALTH_VERIFY_TIMEOUT_SEC)
    while time.monotonic() < deadline:
        try:
            resp = requests.get(HEALTH_URL, timeout=5)
            if resp.ok:
                log.info("Health check passed (HTTP %d)", resp.status_code)
                return True
            log.debug("Health check returned %d, retrying...", resp.status_code)
        except requests.RequestException:
            log.debug("Health check failed, retrying...")
        time.sleep(HEALTH_VERIFY_POLL_SEC)
    log.error("Health check timed out after %ds", HEALTH_VERIFY_TIMEOUT_SEC)
    return False
