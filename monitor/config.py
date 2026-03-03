"""
Voice Agent Auto-Fix Monitor — Configuration.

All tunables come from environment variables with sensible defaults.
"""

from __future__ import annotations

import os
import re
from pathlib import Path


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


def _env_int(key: str, default: int) -> int:
    return int(os.environ.get(key, str(default)))


def _env_float(key: str, default: float) -> float:
    return float(os.environ.get(key, str(default)))


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
VOICE_SYSTEM_DIR = Path(_env("VOICE_SYSTEM_DIR", "/opt/voice-system"))
VOICE_ENV_FILE = VOICE_SYSTEM_DIR / ".env"
DATA_DIR = Path(_env("MONITOR_DATA_DIR", "/data"))
STATE_FILE = DATA_DIR / "state.json"
AUDIT_LOG = DATA_DIR / "audit.log"
COMPOSE_FILE = VOICE_SYSTEM_DIR / "docker-compose.yml"

# ---------------------------------------------------------------------------
# PostgreSQL (from voice-system .env)
# ---------------------------------------------------------------------------
POSTGRES_HOST = _env("POSTGRES_HOST", "postgres")
POSTGRES_PORT = _env_int("POSTGRES_PORT", 5432)
POSTGRES_USER = _env("POSTGRES_USER", "voice_app")
POSTGRES_PASSWORD = _env("POSTGRES_PASSWORD", "")
POSTGRES_DB = _env("POSTGRES_DB", "voice_system")

# ---------------------------------------------------------------------------
# Health / Metrics endpoints
# ---------------------------------------------------------------------------
HEALTH_URL = _env("HEALTH_URL", "http://localhost:3000/health")
PROMETHEUS_URL = _env("PROMETHEUS_URL", "http://localhost:9090")

# ---------------------------------------------------------------------------
# SMTP (optional — if not set, alerts are logged only)
# ---------------------------------------------------------------------------
SMTP_HOST = _env("SMTP_HOST", "")
SMTP_PORT = _env_int("SMTP_PORT", 587)
SMTP_USER = _env("SMTP_USER", "")
SMTP_PASSWORD = _env("SMTP_PASSWORD", "")
EMAIL_FROM = _env("EMAIL_FROM", "monitor@voice.activi.io")
EMAIL_TO = _env("EMAIL_TO", "ds@activi.io")

# ---------------------------------------------------------------------------
# Safety limits
# ---------------------------------------------------------------------------
MAX_FIXES_PER_HOUR = _env_int("MAX_FIXES_PER_HOUR", 3)
COOLDOWN_MINUTES = _env_int("COOLDOWN_MINUTES", 30)
HEALTH_VERIFY_TIMEOUT_SEC = _env_int("HEALTH_VERIFY_TIMEOUT_SEC", 30)
HEALTH_VERIFY_POLL_SEC = _env_int("HEALTH_VERIFY_POLL_SEC", 3)

# ---------------------------------------------------------------------------
# Detection rule thresholds
# ---------------------------------------------------------------------------

# Intro repeat: % of calls in last hour with repeated intro
RULE_INTRO_REPEAT_PCT = _env_float("RULE_INTRO_REPEAT_PCT", 5.0)

# Clarification loop: calls/hour with 2+ clarification turns
RULE_CLARIFICATION_LOOP_COUNT = _env_int("RULE_CLARIFICATION_LOOP_COUNT", 3)

# Rejection rate: % of calls rejected in last 2 hours
RULE_REJECTION_RATE_PCT = _env_float("RULE_REJECTION_RATE_PCT", 60.0)

# Average turns: minimum acceptable avg turns per call (last hour)
RULE_MIN_AVG_TURNS = _env_float("RULE_MIN_AVG_TURNS", 2.0)

# E2E latency P95 threshold in ms
RULE_LATENCY_P95_MS = _env_int("RULE_LATENCY_P95_MS", 3000)

# Error rate: % of calls with result='error' in last hour
RULE_ERROR_RATE_PCT = _env_float("RULE_ERROR_RATE_PCT", 20.0)

# TTS cache miss: max misses per minute (Prometheus rate)
RULE_TTS_CACHE_MISS_PER_MIN = _env_int("RULE_TTS_CACHE_MISS_PER_MIN", 10)

# Stuck calls: calls with no ended_at older than N minutes
RULE_STUCK_CALL_MINUTES = _env_int("RULE_STUCK_CALL_MINUTES", 30)

# Health API: consecutive failures before action
RULE_HEALTH_CONSECUTIVE_FAILURES = _env_int("RULE_HEALTH_CONSECUTIVE_FAILURES", 2)


# ---------------------------------------------------------------------------
# DB DSN builder
# ---------------------------------------------------------------------------
def get_db_dsn() -> str:
    """Build PostgreSQL DSN from env vars."""
    db_url = _env("DATABASE_URL", "")
    if db_url:
        # Replace localhost with docker hostname if needed
        return re.sub(r"@(localhost|127\.0\.0\.1)", "@postgres", db_url)

    from urllib.parse import quote_plus
    return (
        f"postgresql://{quote_plus(POSTGRES_USER)}:{quote_plus(POSTGRES_PASSWORD)}"
        f"@{POSTGRES_HOST}:{POSTGRES_PORT}/{POSTGRES_DB}"
    )
