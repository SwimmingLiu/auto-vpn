MAIN_DATA_PLACEHOLDER = "__MAIN_DATA__"


def replace_main_data(template: str, links: list[str]) -> str:
    if template.count(MAIN_DATA_PLACEHOLDER) != 1:
        raise RuntimeError("Template must contain exactly one MainData placeholder")
    return template.replace(MAIN_DATA_PLACEHOLDER, "\n".join(links), 1)
