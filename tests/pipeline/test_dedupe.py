from vpn_automation.pipeline.dedupe import dedupe_vmess_links


def test_dedupe_vmess_links_removes_same_endpoint_with_different_ps() -> None:
    same_node_a = "vmess://eyJ2IjoiMiIsInBzIjoiQSIsImFkZCI6IjEuMS4xLjEiLCJwb3J0IjoiNDQzIiwiaWQiOiJ1dWlkIiwibmV0Ijoid3MiLCJob3N0IjoiMS4xLjEuMSIsInBhdGgiOiIvd3MiLCJ0bHMiOiJ0bHMiLCJzbmkiOiIifQ=="
    same_node_b = "vmess://eyJ2IjoiMiIsInBzIjoiQiIsImFkZCI6IjEuMS4xLjEiLCJwb3J0IjoiNDQzIiwiaWQiOiJ1dWlkIiwibmV0Ijoid3MiLCJob3N0IjoiMS4xLjEuMSIsInBhdGgiOiIvd3MiLCJ0bHMiOiJ0bHMiLCJzbmkiOiIifQ=="
    deduped = dedupe_vmess_links([same_node_a, same_node_b])
    assert len(deduped) == 1
