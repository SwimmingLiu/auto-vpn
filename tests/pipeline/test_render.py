from vpn_automation.pipeline.render import replace_main_data


def test_replace_main_data_swaps_template_block() -> None:
    template = "const MainData = `old`;\\nconsole.log(MainData);"
    rendered = replace_main_data(template, ["vmess://a", "vmess://b"])
    assert "vmess://a\nvmess://b" in rendered
    assert "`old`" not in rendered
