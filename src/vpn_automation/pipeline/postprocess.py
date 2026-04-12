def decorate_node_name(original_name: str, country_code: str, emoji: str) -> str:
    return f"{emoji} {country_code} {original_name}".strip()
