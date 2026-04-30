import json
import re
from dataclasses import dataclass
from typing import Any

from vpn_automation.config.models import WorkerBuildConfig


@dataclass
class WorkerBuildArtifacts:
    transformed_source: str
    modules: dict[str, str]
    manifest: dict[str, Any]


def build_worker_artifacts(
    rendered_source: str,
    config: WorkerBuildConfig,
    secret_query: str,
) -> WorkerBuildArtifacts:
    secret_key, secret_value = secret_query.split("=", 1)
    transformed_source = _build_transformed_source(rendered_source, config, secret_key, secret_value)
    modules_subdir = config.modules_subdir.strip("/") or "modules"
    modules = {
        f"{modules_subdir}/runtime.js": (
            f"export const workerSource = {json.dumps(transformed_source, ensure_ascii=False)};\n"
        ),
        f"{modules_subdir}/guard.js": (
            f"export const secretParam = {_fragment_literal(secret_key, config.enable_keyword_fragmentation)};\n"
            f"export const secretValue = {_fragment_literal(secret_value, config.enable_keyword_fragmentation)};\n"
        ),
        f"{modules_subdir}/noise.js": (
            f"export const noiseLengthRange = "
            f"[{config.random_noise_min_length}, {config.random_noise_max_length}];\n"
        ),
        f"{modules_subdir}/payload.js": (
            f"export const mainData = {json.dumps(_extract_main_data(rendered_source), ensure_ascii=False)};\n"
        ),
    }
    manifest = {
        "environment_name": config.environment_name,
        "entry_filename": config.entry_filename,
        "modules": sorted(modules),
        "variable_prefix": config.variable_prefix,
        "enable_keyword_fragmentation": config.enable_keyword_fragmentation,
        "enable_identifier_randomization": config.enable_identifier_randomization,
    }
    return WorkerBuildArtifacts(
        transformed_source=transformed_source,
        modules=modules,
        manifest=manifest,
    )


def _build_transformed_source(
    rendered_source: str,
    config: WorkerBuildConfig,
    secret_key: str,
    secret_value: str,
) -> str:
    source = rendered_source
    if config.enable_identifier_randomization:
        prefix = _stable_identifier_prefix(config.variable_prefix)
        replacements = {
            "secretToken": f"{prefix}_secret_token",
            "responsePayload": f"{prefix}_response_payload",
            "randomBytes": f"{prefix}_random_bytes",
            "error": f"{prefix}_error",
        }
        for old_name, new_name in replacements.items():
            source = re.sub(rf"\b{re.escape(old_name)}\b", new_name, source)

    source = source.replace(
        f'searchParams.get("{secret_key}")',
        f"searchParams.get({_fragment_literal(secret_key, config.enable_keyword_fragmentation)})",
    )
    source = source.replace(
        f'=== "{secret_value}"',
        f"=== {_fragment_literal(secret_value, config.enable_keyword_fragmentation)}",
    )
    comment = config.comment_template.format(environment_name=config.environment_name)
    return f"// {comment}\n{source}"


def _stable_identifier_prefix(prefix: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_]+", "_", str(prefix or "sg")).strip("_")
    if not normalized:
        return "sg"
    if normalized[0].isdigit():
        return f"sg_{normalized}"
    return normalized


def _fragment_literal(value: str, enabled: bool) -> str:
    if not enabled:
        return json.dumps(value, ensure_ascii=False)
    parts = _split_literal(value)
    quoted = ", ".join(json.dumps(part, ensure_ascii=False).replace('"', "'") for part in parts)
    return f"[{quoted}].join('')"


def _split_literal(value: str) -> list[str]:
    if "_" in value:
        head, tail = value.split("_", 1)
        head_parts = [head[:3], head[3:]]
        return [part for part in [*head_parts, f"_{tail}"] if part]
    if len(value) > 8:
        return [part for part in [value[:4], value[4:8], value[8:]] if part]
    if len(value) > 4:
        return [part for part in [value[:4], value[4:]] if part]
    return [value]


def _extract_main_data(rendered_source: str) -> str:
    match = re.search(
        r"const (?:MainData|SUBSCRIPTION_PAYLOAD) = `(?P<payload>[\s\S]*?)`;",
        rendered_source,
    )
    if not match:
        return ""
    return match.group("payload")
