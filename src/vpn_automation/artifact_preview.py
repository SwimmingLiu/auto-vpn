import base64
import json
import re
from pathlib import Path
from typing import Any

from vpn_automation.redaction import redact_text, safe_deployment


FINAL_NODE_FILES = ("vpn_node_emoji.txt", "vpn_node_availability.txt", "vpn_node_speedtest.txt")


def _format_bytes(size: int) -> str:
    if size >= 1024 * 1024:
        return f"{size / 1024 / 1024:.1f} MB"
    if size >= 1024:
        return f"{(size + 1023) // 1024} KB"
    return f"{size} B"


def _load_report(artifact_dir: Path) -> dict[str, Any]:
    report_path = artifact_dir / "pipeline_report.json"
    if not report_path.exists():
        return {}
    try:
        return json.loads(report_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"error": "invalid pipeline_report.json"}


def _file_inventory(artifact_dir: Path) -> list[dict[str, Any]]:
    return sorted(
        [
            {"name": path.name, "size": _format_bytes(path.stat().st_size)}
            for path in artifact_dir.iterdir()
            if path.is_file()
        ],
        key=lambda item: str(item["name"]),
    )


def _decode_vmess_region(link: str) -> str:
    value = link.strip()
    if not value.startswith("vmess://"):
        return "OTHER"
    encoded = value[len("vmess://") :]
    encoded += "=" * ((4 - len(encoded) % 4) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(encoded.encode("ascii")).decode("utf-8"))
    except Exception:
        return "OTHER"
    name = str(payload.get("ps", "")).upper()
    match = re.search(r"\b([A-Z]{2})\b", name)
    return match.group(1) if match else "OTHER"


def _safe_node_counts(artifact_dir: Path) -> dict[str, Any]:
    node_source = next((name for name in FINAL_NODE_FILES if (artifact_dir / name).exists()), "")
    if not node_source:
        return {"node_source": "", "final_node_count": 0, "regions": []}
    lines = [
        line.strip()
        for line in (artifact_dir / node_source).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    counts: dict[str, int] = {}
    for line in lines:
        region = _decode_vmess_region(line)
        counts[region] = counts.get(region, 0) + 1
    return {
        "node_source": node_source,
        "final_node_count": len(lines),
        "regions": [
            {"region_code": region, "count": count}
            for region, count in sorted(counts.items(), key=lambda item: item[0])
        ],
    }


def preview_artifact_json(artifact_dir: Path) -> str:
    resolved = artifact_dir.resolve()
    if not resolved.exists() or not resolved.is_dir():
        return json.dumps({"ok": False, "artifact_dir": str(resolved)}, ensure_ascii=False)

    report = _load_report(resolved)
    payload = {
        "ok": True,
        "artifact_dir": str(resolved),
        "run_status": report.get("run_status", ""),
        "stage_status": report.get("stage_status", {}),
        "counts": report.get("counts", {}),
        "source_counts": report.get("source_counts", {}),
        "deployment": safe_deployment(report.get("deployment", {}) or {}),
        "retry_context": report.get("retry_context", {}) or {},
        "error": redact_text(str(report.get("error", ""))),
        "files": _file_inventory(resolved),
        "safe_node_counts": _safe_node_counts(resolved),
    }
    return json.dumps(payload, ensure_ascii=False)
