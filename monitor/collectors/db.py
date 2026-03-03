"""
Voice Agent Auto-Fix Monitor — Database collector.

Runs PostgreSQL queries against the voice_system database to detect
anomalies in calls, turns, and metrics.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta
from typing import Any

import psycopg2
import psycopg2.extras

from config import get_db_dsn

log = logging.getLogger("monitor.collectors.db")


def collect() -> dict[str, Any]:
    """Collect all DB metrics needed by the rules engine."""
    dsn = get_db_dsn()
    result: dict[str, Any] = {}

    try:
        conn = psycopg2.connect(dsn, connect_timeout=10)
        conn.autocommit = True
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    except Exception as exc:
        log.error("DB connection failed: %s", exc)
        return {"error": str(exc)}

    try:
        # --- Call stats (last 1 hour) ---
        cutoff_1h = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        cur.execute("""
            SELECT
                COUNT(*) AS total_calls,
                COUNT(*) FILTER (WHERE result = 'error') AS error_calls,
                COUNT(*) FILTER (WHERE result = 'rejected') AS rejected_calls,
                COALESCE(ROUND(AVG(turn_count)::numeric, 2), 0) AS avg_turn_count,
                COUNT(*) FILTER (WHERE result = 'error')::float /
                    NULLIF(COUNT(*), 0) * 100 AS error_rate_pct
            FROM calls
            WHERE created_at >= %s
        """, (cutoff_1h,))
        row = cur.fetchone()
        result["calls_1h"] = dict(row) if row else {}

        # --- Rejection rate (last 2 hours) ---
        cutoff_2h = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        cur.execute("""
            SELECT
                COUNT(*) AS total_calls,
                COUNT(*) FILTER (WHERE result = 'rejected') AS rejected_calls,
                COUNT(*) FILTER (WHERE result = 'rejected')::float /
                    NULLIF(COUNT(*), 0) * 100 AS rejection_rate_pct
            FROM calls
            WHERE created_at >= %s
        """, (cutoff_2h,))
        row = cur.fetchone()
        result["calls_2h"] = dict(row) if row else {}

        # --- Intro repeat detection ---
        # Calls where turn_number > 1 has bot text matching intro pattern
        cur.execute("""
            SELECT COUNT(DISTINCT t.call_id) AS intro_repeat_calls
            FROM turns t
            JOIN calls c ON c.call_id = t.call_id
            WHERE c.created_at >= %s
              AND t.turn_number > 1
              AND t.speaker = 'bot'
              AND (t.text ILIKE '%%dobar dan%%goran%%step%%'
                   OR t.text ILIKE '%%dobar dan%%vesna%%step%%')
        """, (cutoff_1h,))
        row = cur.fetchone()
        total_1h = result["calls_1h"].get("total_calls", 0)
        intro_count = row["intro_repeat_calls"] if row else 0
        result["intro_repeat"] = {
            "count": intro_count,
            "pct": (intro_count / total_1h * 100) if total_1h > 0 else 0,
        }

        # --- Clarification loop detection ---
        # Calls with 2+ bot turns containing clarification phrases
        cur.execute("""
            SELECT COUNT(DISTINCT sub.call_id) AS loop_calls
            FROM (
                SELECT t.call_id, COUNT(*) AS clarify_count
                FROM turns t
                JOIN calls c ON c.call_id = t.call_id
                WHERE c.created_at >= %s
                  AND t.speaker = 'bot'
                  AND (t.text ILIKE '%%molim%%'
                       OR t.text ILIKE '%%pojasniti%%'
                       OR t.text ILIKE '%%ponoviti%%')
                GROUP BY t.call_id
                HAVING COUNT(*) >= 2
            ) sub
        """, (cutoff_1h,))
        row = cur.fetchone()
        result["clarification_loops"] = row["loop_calls"] if row else 0

        # --- E2E latency P95 ---
        cur.execute("""
            SELECT
                COALESCE(
                    ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY t.latency_ms)::numeric, 2),
                    0
                ) AS p95_latency_ms
            FROM turns t
            JOIN calls c ON c.call_id = t.call_id
            WHERE c.created_at >= %s
              AND t.latency_ms IS NOT NULL
              AND t.latency_ms > 0
        """, (cutoff_1h,))
        row = cur.fetchone()
        result["latency_p95_ms"] = float(row["p95_latency_ms"]) if row else 0

        # --- Stuck calls ---
        cutoff_stuck = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
        cur.execute("""
            SELECT COUNT(*) AS stuck_calls
            FROM calls
            WHERE ended_at IS NULL
              AND created_at < %s
        """, (cutoff_stuck,))
        row = cur.fetchone()
        result["stuck_calls"] = row["stuck_calls"] if row else 0

    except Exception as exc:
        log.error("DB query error: %s", exc)
        result["error"] = str(exc)
    finally:
        try:
            cur.close()
            conn.close()
        except Exception:
            pass

    return result
