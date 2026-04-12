from vpn_automation.pipeline.vmess import canonical_key, parse_vmess_link


def dedupe_vmess_links(links: list[str]) -> list[str]:
    seen = set()
    result: list[str] = []
    for link in links:
        key = canonical_key(parse_vmess_link(link))
        if key in seen:
            continue
        seen.add(key)
        result.append(link)
    return result
