from vpn_automation.pipeline.postprocess import decorate_node_name


def test_decorate_node_name_prefixes_emoji_and_country() -> None:
    updated = decorate_node_name("Node-1", "US", "🇺🇸")
    assert updated == "🇺🇸 US Node-1"
