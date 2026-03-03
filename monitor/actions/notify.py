"""
Voice Agent Auto-Fix Monitor — Notification system.

Sends email alerts for Tier 2 and Tier 3 events.
Falls back to logging if SMTP is not configured.
"""

from __future__ import annotations

import logging
import smtplib
from datetime import datetime, timezone
from email.mime.text import MIMEText
from typing import Any

from config import (
    AUDIT_LOG,
    DATA_DIR,
    EMAIL_FROM,
    EMAIL_TO,
    SMTP_HOST,
    SMTP_PASSWORD,
    SMTP_PORT,
    SMTP_USER,
)
from rules.engine import Alert

log = logging.getLogger("monitor.actions.notify")


def send_alert(alert: Alert, fix_result: dict[str, Any]) -> None:
    """Send notification for a triggered alert."""
    # Always write to audit log
    _write_audit(alert, fix_result)

    # Only email for Tier 2+ if SMTP is configured
    if alert.tier >= 2 and SMTP_HOST:
        _send_email(alert, fix_result)
    elif alert.tier >= 2:
        log.warning(
            "SMTP not configured — Tier %d alert '%s' logged only: %s",
            alert.tier, alert.rule, alert.description,
        )


def send_budget_exhausted(state: dict[str, Any]) -> None:
    """Special alert when fix budget is exhausted."""
    fixes = state.get("fixes_this_hour", [])
    body = (
        f"Auto-fix budget exhausted ({len(fixes)} fixes in the last hour).\n"
        f"Recent fixes:\n"
    )
    for fix in fixes[-5:]:
        body += f"  - {fix.get('type')} at {fix.get('at')} (trigger: {fix.get('trigger')})\n"
    body += "\nManual intervention may be required."

    _write_audit_raw("BUDGET_EXHAUSTED", body)
    if SMTP_HOST:
        _send_email_raw(
            subject="[Voice Monitor] Fix budget exhausted",
            body=body,
        )
    else:
        log.error("Fix budget exhausted: %s", body)


def _write_audit(alert: Alert, fix_result: dict[str, Any]) -> None:
    """Append to audit log file."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).isoformat()
    line = (
        f"{ts} | Tier {alert.tier} | {alert.rule} | "
        f"{alert.description} | fix={fix_result.get('applied')} "
        f"reason={fix_result.get('reason')} verified={fix_result.get('verified')}\n"
    )
    with open(AUDIT_LOG, "a", encoding="utf-8") as fh:
        fh.write(line)


def _write_audit_raw(event: str, body: str) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).isoformat()
    with open(AUDIT_LOG, "a", encoding="utf-8") as fh:
        fh.write(f"{ts} | {event} | {body.replace(chr(10), ' ')}\n")


def _send_email(alert: Alert, fix_result: dict[str, Any]) -> None:
    tier_label = {1: "Auto-Fix (silent)", 2: "Auto-Fix + Alert", 3: "Alert Only"}
    subject = f"[Voice Monitor] [{tier_label.get(alert.tier, 'Unknown')}] {alert.rule}"

    body = (
        f"Rule: {alert.rule}\n"
        f"Tier: {alert.tier}\n"
        f"Description: {alert.description}\n"
        f"Value: {alert.value}\n"
        f"Threshold: {alert.threshold}\n"
        f"\n"
        f"Fix Applied: {fix_result.get('applied')}\n"
        f"Reason: {fix_result.get('reason')}\n"
        f"Verified: {fix_result.get('verified')}\n"
        f"\n"
        f"Time: {datetime.now(timezone.utc).isoformat()}\n"
        f"Server: 157.90.126.58\n"
    )
    _send_email_raw(subject, body)


def _send_email_raw(subject: str, body: str) -> None:
    """Send email via SMTP."""
    if not SMTP_HOST:
        return

    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = EMAIL_FROM
    msg["To"] = EMAIL_TO

    try:
        if SMTP_PORT == 465:
            smtp = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=10)
        else:
            smtp = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10)
            smtp.starttls()

        if SMTP_USER and SMTP_PASSWORD:
            smtp.login(SMTP_USER, SMTP_PASSWORD)
        smtp.sendmail(EMAIL_FROM, [EMAIL_TO], msg.as_string())
        smtp.quit()
        log.info("Email sent: %s", subject)
    except Exception as exc:
        log.error("Failed to send email: %s", exc)
