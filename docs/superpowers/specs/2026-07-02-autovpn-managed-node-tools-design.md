# AutoVPN Managed Runtime Tools Design

## Goal

AutoVPN should not reach a late pipeline stage and then block on an npm prompt or fail because a runtime tool is missing. It should check required local runtime tools before the pipeline starts, install missing managed tools into an AutoVPN-owned user directory when AutoVPN can safely do so, verify them, and only then continue.

The immediate failure came from `javascript-obfuscator`, because the current Python obfuscation backend runs `npx javascript-obfuscator` from the artifact directory. In a user environment where the package is not locally available from that working directory, npm may prompt to install it and the headless run can hang indefinitely.

The same dependency pattern also applies to Cloudflare Wrangler. Deploy and verify-adjacent workflows currently call `npx wrangler ...`; this can hit the same prompt, cache, or network behavior. The design should therefore cover all AutoVPN runtime tools, while implementing the first pass for the tools that are both npm-managed and used by the pipeline: `javascript-obfuscator` and `wrangler`.

## User Model

Most users do not have a "project root" concept. Runtime dependencies that AutoVPN needs should live in an AutoVPN-managed user location rather than relying on source checkout state. A source checkout may still provide developer conveniences, but production behavior should not depend on it.

## Approach

Add a managed runtime tool resolver with first-class support for npm tools.

The resolver will prefer AutoVPN user-level installations, such as:

```text
~/.auto-vpn/tools/npm/javascript-obfuscator/<version>/
~/.auto-vpn/tools/npm/wrangler/<version>/
```

The exact on-disk shape can use a small package directory per tool/version with its own `package.json` and `node_modules/.bin/<tool>`. The resolver returns an absolute executable path and metadata describing where it came from.

Project-local `node_modules/.bin/<tool>` remains a development fallback only. It is useful when working from source, but it should not be the default user-facing dependency location.

Runtime tools fall into three categories:

- **Managed npm tools:** AutoVPN can install and verify these in its user-level tool directory. Initial scope: `javascript-obfuscator`, `wrangler`.
- **External system binaries:** AutoVPN can detect and validate these, but should not silently install them because installation is OS-specific and may require elevated permissions. Initial scope: `node`, `npm`, `mihomo`.
- **Bundled or browser assets:** AutoVPN can detect, guide installation, or use packaged copies depending on distribution. Initial scope: Playwright package and browser binaries.

## Resolution Order

1. Use a valid managed AutoVPN user-level install for managed tools.
2. If the managed install is missing, install it into the managed tool directory.
3. Re-check the managed install after installation.
4. In source/development contexts, allow project-local fallback if explicitly available and valid.
5. Fail with a clear dependency error if no verified tool is available.

Pipeline steps use resolved absolute commands for managed tools. They must not call bare `npx javascript-obfuscator` or `npx wrangler` from arbitrary working directories.

## Preflight And Auto-Install

`doctor` and run preflight should check the dependency set required for the selected run mode:

- `node` exists and can execute.
- `npm` exists and can execute.
- `javascript-obfuscator` is available through the managed resolver when obfuscation may run.
- `wrangler` is available through the managed resolver when deploy may run.
- `mihomo` is available when speed or availability configuration requires it.
- Playwright package and browser assets are available when availability checks require browser probing.
- Cloudflare credentials and account configuration are present when deploy or verify may run.

If a managed npm tool is missing, AutoVPN should install it before the pipeline starts. The install command must be non-interactive and bounded by a timeout. After installation, AutoVPN re-runs the resolver and verifies:

- `javascript-obfuscator --version` exits successfully, and a minimal obfuscation smoke test can run in a temporary directory whose cwd is not the project root.
- `wrangler --version` and `wrangler pages deploy --help` exit successfully without interactive prompts.

If installation fails, the pipeline should stop before extraction, speed testing, deploy, or verify work begins. The error should say which dependency is missing, where AutoVPN tried to install it, and include a safe, truncated install error.

For external system binaries that AutoVPN cannot safely install, preflight should fail early with clear instructions. AutoVPN should not attempt global package-manager operations such as `apt install`, `brew install`, or `npm install -g` without an explicit future design.

## Pipeline Integration

`src/vpn_automation/integrations/node_tools.py` should no longer construct `["npx", "javascript-obfuscator", ...]` as the normal command. It should ask the resolver for the executable and then append the existing obfuscator arguments.

The cwd can remain the artifact directory for input/output locality, because the executable will now be absolute and verified.

Cloudflare deploy code in both Python and Node paths should no longer construct `npx wrangler ...` as the normal command. It should ask the same resolver for the Wrangler executable and then append the existing deploy arguments.

## Error Handling

All managed tool operations should be deterministic:

- no interactive prompts
- explicit timeout
- clear failure message
- safe truncation of stdout/stderr
- no subscription URLs, node links, or secrets in error messages

If npm is missing, AutoVPN should report that Node/npm is required and cannot auto-install managed npm tools without npm.

## Reporting

Doctor output should distinguish:

- managed install found
- managed install installed successfully
- development fallback used
- install failed
- node/npm missing
- unmanaged system dependency missing
- dependency not required for this run mode

The normal run report should only include safe metadata such as tool source and version. It should not include raw command output if it might contain unrelated environment details.

## Testing

Add tests for:

- resolver uses existing managed installs for `javascript-obfuscator` and `wrangler`
- missing managed npm tools trigger non-interactive installation
- install failure stops before pipeline work
- project-local fallback works for development
- obfuscation from an artifact cwd uses an absolute executable and does not invoke npm prompt behavior
- deploy uses an absolute Wrangler executable and does not invoke npm prompt behavior
- doctor reports missing node/npm/obfuscator/wrangler/mihomo/Playwright clearly according to run mode
- existing obfuscator flags are preserved

End-to-end verification should retry from `obfuscate` against an artifact and confirm `_worker.js` and `pages_bundle/_worker.js` are generated without any interactive npm prompt. Deploy verification should confirm Wrangler is resolved through the managed tool layer rather than through bare `npx`.

## Non-Goals

- Do not globally install npm packages.
- Do not require users to understand or repair project-local `node_modules`.
- Do not silently install OS-level dependencies such as Node.js or Mihomo through system package managers.
- Do not redesign the Worker transformation or deployment flow.
- Do not change obfuscator settings as part of this task.
