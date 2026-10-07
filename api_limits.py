"""Respect Google's retry deadlines, including daily quota exhaustion."""
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import math


def retry_delay(error=None, headers=None, default=15):
    delays = [default]
    if headers:
        value = headers.get("Retry-After")
        if value:
            try:
                delays.append(float(value))
            except (TypeError, ValueError):
                try:
                    delays.append((parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds())
                except (TypeError, ValueError, OverflowError):
                    pass
    error = error if isinstance(error, dict) else {}
    details = error.get("details", [])
    if not isinstance(details, list):
        details = []
    daily = False
    for detail in details:
        if not isinstance(detail, dict):
            continue
        value = detail.get("retryDelay")
        try:
            if isinstance(value, dict):
                delays.append(float(value.get("seconds", 0)) + float(value.get("nanos", 0)) / 1e9)
            elif isinstance(value, str) and value.endswith("s"):
                delays.append(float(value[:-1]))
        except (TypeError, ValueError):
            pass
        violations = detail.get("violations", [])
        if isinstance(violations, list):
            daily |= any("perday" in str(v.get("quotaId", "")).lower() for v in violations if isinstance(v, dict))
    valid = [value for value in delays if math.isfinite(value) and value > 0]
    # A daily quota without a reset hint must not be retried every few seconds.
    if daily and len(delays) == 1:
        valid.append(86400)
    return max([1, *valid])
