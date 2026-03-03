"""
Voice Agent Auto-Fix Monitor — State persistence.

Tracks fix history, cooldowns, and consecutive failure counters
in a JSON file that survives container restarts.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config import DATA_DIR, STATE_FILE

log = logging.getLogger("monitor.state")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_state() -> dict[str, Any]:
    return {
        "last_run": None,
        "fixes_this_hour": [],
        "cooldowns": {},
        "consecutive_failures": {},
    }


def load() -> dict[str, Any]:
    """Load state from disk, return default if missing or corrupt."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not STATE_FILE.exists():
        log.info("No state file found, starting fresh")
        return _default_state()
    try:
        with open(STATE_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
        log.debug("State loaded: %d fixes tracked", len(data.get("fixes_this_hour", [])))
        return data
    except (json.JSONDecodeError, OSError) as exc:
        log.warning("Corrupt state file, resetting: %s", exc)
        return _default_state()


def save(state: dict[str, Any]) -> None:
    """Persist state to disk."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    state["last_run"] = _now()
    with open(STATE_FILE, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, default=str)
    log.debug("State saved")


def record_fix(state: dict[str, Any], fix_type: str, trigger: str) -> None:
    """Record a fix in the state for rate-limiting and cooldown tracking."""
    now = _now()
    state["fixes_this_hour"].append({
        "type": fix_type,
        "at": now,
        "trigger": trigger,
    })
    state["cooldowns"][fix_type] = now


def increment_failure(state: dict[str, Any], key: str) -> int:
    """Increment consecutive failure counter, return new value."""
    current = state["consecutive_failures"].get(key, 0) + 1
    state["consecutive_failures"][key] = current
    return current


def reset_failure(state: dict[str, Any], key: str) -> None:
    """Reset consecutive failure counter to 0."""
    state["consecutive_failures"][key] = 0
