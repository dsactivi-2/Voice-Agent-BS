"""
Voice Agent Auto-Fix Monitor — Health API collector.

Checks the /health endpoint for service-level health status.
"""

from __future__ import annotations

import logging
from typing import Any

import requests

from config import HEALTH_URL

log = logging.getLogger("monitor.collectors.health")


def collect() -> dict[str, Any]:
    """Call the /health endpoint and return service statuses."""
    try:
        resp = requests.get(HEALTH_URL, timeout=5)
        if resp.ok:
            data = resp.json()
            return {
                "reachable": True,
                "status_code": resp.status_code,
                "services": data.get("services", data.get("checks", {})),
                "uptime": data.get("uptime", None),
            }
        else:
            log.warning("Health endpoint returned HTTP %d", resp.status_code)
            return {
                "reachable": True,
                "status_code": resp.status_code,
                "services": {},
            }
    except requests.ConnectionError:
        log.error("Health endpoint unreachable at %s", HEALTH_URL)
        return {"reachable": False, "status_code": None, "services": {}}
    except requests.Timeout:
        log.error("Health endpoint timed out at %s", HEALTH_URL)
        return {"reachable": False, "status_code": None, "services": {}}
    except Exception as exc:
        log.error("Health check error: %s", exc)
        return {"reachable": False, "status_code": None, "services": {}, "error": str(exc)}
