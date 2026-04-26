import pytest

from vpn_automation.pipeline.render import MAIN_DATA_PLACEHOLDER, replace_main_data


def test_replace_main_data_replaces_only_placeholder() -> None:
    template = f"const MainData = `{MAIN_DATA_PLACEHOLDER}`;\\nconst footer = 'keep';"
    rendered = replace_main_data(template, ["vmess://a", "vmess://b"])
    assert rendered == "const MainData = `vmess://a\nvmess://b`;\\nconst footer = 'keep';"
    assert MAIN_DATA_PLACEHOLDER not in rendered


def test_replace_main_data_requires_single_placeholder() -> None:
    with pytest.raises(RuntimeError, match="exactly one MainData placeholder"):
        replace_main_data("const MainData = ``;", ["vmess://a"])
