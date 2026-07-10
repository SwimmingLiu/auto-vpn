# AutoVPN Headless Operations

This directory contains the active operating guides for the Node.js CLI.
Node.js `>=22.5.0` is the only application runtime required by AutoVPN.

## Start Here

- [Linux headless guide](linux-headless-guide.md): install and run the CLI.
- [Agent skill](agent-skill.md): command policy for automated operators.
- [Job manager](job-manager.md): detached job lifecycle and recovery.
- [Linux delivery](linux-delivery.md): CI and release verification.

## Supported Entry Points

```bash
npm install -g @swimmingliu/autovpn
autovpn --version
autovpn doctor --project-root /opt/autovpn --output json
autovpn run --project-root /opt/autovpn --output jsonl
autovpn serve --project-root /opt/autovpn
```

Runtime data defaults to `$HOME/.auto-vpn`. Set
`VPN_AUTOMATION_RUNTIME_ROOT` when service accounts need a different location.

Documents outside this directory that describe earlier migration phases are
historical records, not operating instructions.
