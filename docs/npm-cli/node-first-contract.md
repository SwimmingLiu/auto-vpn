# AutoVPN Node CLI Contract

This is the active command contract for `@swimmingliu/autovpn`. Node.js
`>=22.5.0` is the only application runtime.

## Commands

- `doctor`, `profile`, and `artifacts` return stable human or JSON output.
- `run`, `resume`, and `retry-stage` emit human output or one JSON event per line.
- `status`, `logs`, `stop`, and `jobs` manage durable detached jobs.
- `serve` exposes the Electron renderer through a token-protected HTTP service.

## Exit Codes

- `0`: command completed successfully.
- `1`: operation failed after argument validation.
- `2`: command-line usage is invalid.

## Streams

Structured output is written to stdout. Diagnostics are written to stderr.
Foreground JSONL commands emit events as stages complete and end with a summary
event. The CLI must not mix prose into JSON or JSONL stdout.

## Paths

`--project-root` selects project assets. Runtime state defaults to
`$HOME/.auto-vpn` and can be moved with `VPN_AUTOMATION_RUNTIME_ROOT`.
Explicit profile and artifacts path variables override their default locations.

## Security

Public output must redact credentials, source URLs, subscription links, worker
secrets, and access tokens. Child commands use argument arrays with no shell
interpolation. Server mode requires authentication for non-loopback binds unless
the operator explicitly selects no-auth mode.

## Packaging

The npm tarball contains the CLI entry, built code, package manifest, and
production dependencies declared by the package. The Electron runtime stages
the same built CLI and invokes it with Electron's Node mode in packaged apps.
