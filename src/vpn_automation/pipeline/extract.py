import json
from pathlib import Path


def build_source_script_path(sibling_root: Path, source_name: str) -> Path:
    return sibling_root / "run" / f"{source_name}.py"


def write_vpn_api_config(config_path: Path, payload: dict) -> None:
    config_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
