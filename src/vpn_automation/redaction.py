import re
from typing import Any


SECRET_DEPLOYMENT_KEYS = {
    "subscription_url",
    "verify_subscription_url",
    "secret_query",
    "share_project_sub_value",
    "pages_secret_admin",
}

SECRET_TEXT_PATTERNS = (
    (re.compile(r"(token=)[^&\s\"']+"), r"\1<redacted>"),
    (re.compile(r"(serect_key=)[^&\s\"']+"), r"\1<redacted>"),
    (re.compile(r"(secret_key=)[^&\s\"']+"), r"\1<redacted>"),
    (re.compile(r"(api[_-]?token=)[^&\s\"']+", re.IGNORECASE), r"\1<redacted>"),
    (re.compile(r"vmess://[A-Za-z0-9_\-+/=]+"), "vmess://<redacted>"),
)


def redact_text(value: str) -> str:
    redacted = value
    for pattern, replacement in SECRET_TEXT_PATTERNS:
        redacted = pattern.sub(replacement, redacted)
    return redacted


def safe_deployment(deployment: dict[str, Any]) -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for key, value in deployment.items():
        if key in SECRET_DEPLOYMENT_KEYS:
            safe[key] = "set" if value else ""
        elif isinstance(value, str):
            safe[key] = redact_text(value)
        elif isinstance(value, (int, float, bool)) or value is None:
            safe[key] = value
        elif isinstance(value, list):
            safe[key] = [_redact_nested(item) for item in value]
        elif isinstance(value, dict):
            safe[key] = {str(nested_key): _redact_nested(nested_value) for nested_key, nested_value in value.items()}
        else:
            safe[key] = str(type(value).__name__)
    return safe


def _redact_nested(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        return [_redact_nested(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _redact_nested(item) for key, item in value.items()}
    return str(type(value).__name__)
