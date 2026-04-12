from pathlib import Path

from vpn_automation.pipeline.extract import build_source_script_path


def test_build_source_script_path_points_to_existing_run_script() -> None:
    sibling_root = Path("/Users/swimmingliu/data/VPN/vpn-catch-nodes")
    script_path = build_source_script_path(sibling_root, "leiting")
    assert script_path == sibling_root / "run" / "leiting.py"
