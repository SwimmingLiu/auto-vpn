import os
import subprocess


COMMON_CLI_PATHS = (
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
)


def build_command_env(env: dict[str, str] | None = None) -> dict[str, str]:
    merged_env = dict(os.environ)
    if env:
        merged_env.update(env)

    seen: set[str] = set()
    path_entries: list[str] = []
    for entry in merged_env.get("PATH", "").split(os.pathsep):
        normalized = entry.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        path_entries.append(normalized)

    for candidate in COMMON_CLI_PATHS:
        if candidate in seen:
            continue
        seen.add(candidate)
        path_entries.append(candidate)

    merged_env["PATH"] = os.pathsep.join(path_entries)
    return merged_env


def run_command(
    command: list[str],
    cwd: str | None = None,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        env=build_command_env(env),
        text=True,
        capture_output=True,
        check=False,
    )
