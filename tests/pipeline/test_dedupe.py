from pathlib import Path

from vpn_automation.pipeline.dedupe import dedupe_vmess_links


def test_dedupe_vmess_links_removes_same_endpoint_with_different_ps() -> None:
    same_node_a = "vmess://eyJ2IjoiMiIsInBzIjoiQSIsImFkZCI6IjEuMS4xLjEiLCJwb3J0IjoiNDQzIiwiaWQiOiJ1dWlkIiwibmV0Ijoid3MiLCJob3N0IjoiMS4xLjEuMSIsInBhdGgiOiIvd3MiLCJ0bHMiOiJ0bHMiLCJzbmkiOiIifQ=="
    same_node_b = "vmess://eyJ2IjoiMiIsInBzIjoiQiIsImFkZCI6IjEuMS4xLjEiLCJwb3J0IjoiNDQzIiwiaWQiOiJ1dWlkIiwibmV0Ijoid3MiLCJob3N0IjoiMS4xLjEuMSIsInBhdGgiOiIvd3MiLCJ0bHMiOiJ0bHMiLCJzbmkiOiIifQ=="
    deduped = dedupe_vmess_links([same_node_a, same_node_b])
    assert len(deduped) == 1


def test_dedupe_fixture_matches_python_golden_output() -> None:
    fixture_dir = Path(__file__).resolve().parents[1] / "fixtures" / "node-migration" / "pipeline" / "dedupe"
    input_links = [line.strip() for line in (fixture_dir / "input.txt").read_text(encoding="utf-8").splitlines() if line.strip()]
    expected_links = [line.strip() for line in (fixture_dir / "output.txt").read_text(encoding="utf-8").splitlines() if line.strip()]

    assert dedupe_vmess_links(input_links) == expected_links
