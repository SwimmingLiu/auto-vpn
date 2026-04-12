import re


def replace_main_data(template: str, links: list[str]) -> str:
    replacement = "const MainData = `" + "\n".join(links) + "`"
    return re.sub(r"const MainData = `.*?`", replacement, template, count=1, flags=re.S)
