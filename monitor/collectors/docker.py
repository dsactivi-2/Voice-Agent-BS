"""
Voice Agent Auto-Fix Monitor — Docker collector.

Checks container health status via the Docker API.
"""

from __future__ import annotations

import logging
import subprocess
import json
from typing import Any

log = logging.getLogger("monitor.collectors.docker")

# Target containers to monitor
CONTAINERS = ["orchestrator", "postgres", "redis"]


def collect() -> dict[str, Any]:
    """Collect health status for all voice-system containers."""
    result: dict[str, Any] = {}

    for name in CONTAINERS:
        try:
            # Use docker inspect to get container state
            proc = subprocess.run(
                ["docker", "inspect", "--format",
                 '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}',
                 f"voice-system-{name}-1"],
                capture_output=True, text=True, timeout=10,
            )
            if proc.returncode != 0:
                # Try alternative naming convention
                proc = subprocess.run(
                    ["docker", "inspect", "--format",
                     '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}',
                     f"voice-system_{name}_1"],
                    capture_output=True, text=True, timeout=10,
                )

            if proc.returncode == 0:
                parts = proc.stdout.strip().split("|")
                result[name] = {
                    "status": parts[0] if len(parts) > 0 else "unknown",
                    "health": parts[1] if len(parts) > 1 else "unknown",
                }
            else:
                result[name] = {"status": "not_found", "health": "unknown"}
                log.warning("Container %s not found", name)

        except subprocess.TimeoutExpired:
            result[name] = {"status": "timeout", "health": "unknown"}
            log.warning("Docker inspect timed out for %s", name)
        except Exception as exc:
            result[name] = {"status": "error", "health": "unknown"}
            log.warning("Docker inspect failed for %s: %s", name, exc)

    return result
