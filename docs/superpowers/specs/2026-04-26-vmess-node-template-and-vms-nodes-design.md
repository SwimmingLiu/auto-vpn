# Vmess Node Template and VMS-Nodes Deploy Design

## Outcome

Make the `render -> obfuscate -> deploy` tail of the pipeline match the sibling Cloudflare worker reference exactly where required. The generated un-obfuscated worker must follow `/Users/swimmingliu/data/VPN/cloudflarevpn/edgetunnel/vmess_node.js`, pipeline runs may only inject the current run's `MainData` payload, obfuscation flags must match `/Users/swimmingliu/data/VPN/cloudflarevpn/edgetunnel/.github/workflows/obfuscator_vmessnode.yml`, and the default Pages deployment target must move from `vmessnodes` to `vms-nodes`.

## Requirements

- The un-obfuscated worker source emitted by the pipeline must preserve the reference worker structure and behavior:
  - `serect_key` query parameter gate
  - random garbage response for non-matching requests
  - `btoa(req_data)` response body
  - exported `fetch` handler shape
- Pipeline execution may only change the contents injected into `MainData`.
- Template rendering should use a dedicated placeholder token inside `MainData` instead of rewriting the whole block with a loose regex.
- Rendering must fail loudly if the placeholder is missing or appears more than once.
- Obfuscation flags must be kept in sync with the reference GitHub Actions workflow.
- Default deploy settings must target the `vms-nodes` Cloudflare Pages project and its `https://vms-nodes.pages.dev` domain.
- Existing verification behavior should continue to use `secret_query` and `pages_project_url` only for verification URL construction, not for template code generation.

## Architecture

### Worker template

Replace `/Users/swimmingliu/data/VPN/vpn-subscription-automation/templates/vmess_node.js` with a template derived from `/Users/swimmingliu/data/VPN/cloudflarevpn/edgetunnel/vmess_node.js`. The only intentional divergence is that the `MainData` string body contains a sentinel placeholder such as `__MAIN_DATA__` instead of hard-coded nodes.

This keeps the worker logic frozen while allowing the pipeline to inject run output. The generated runtime file should still be a normal worker script with the final node list inside `MainData`.

### Render contract

Keep rendering in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/render.py`, but tighten its contract:

- count placeholder occurrences
- require exactly one placeholder
- replace only that placeholder with newline-joined node data
- preserve all surrounding code bytes unchanged

This is stricter than the current regex-based `const MainData = ...` swap and directly encodes the "only mutate `MainData`" rule.

### Obfuscation

Keep `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/integrations/node_tools.py` as the source of truth for the `javascript-obfuscator` command. Update its arguments to exactly mirror the reference workflow flags so that local pipeline output and sibling-project CI output use the same transform profile.

The pipeline artifact flow stays the same:

1. render template to plain worker JS
2. obfuscate into `vmess_node_worker.js`
3. package obfuscated content into `pages_bundle/_worker.js`
4. deploy with Wrangler

### Deploy defaults

Update the default deploy profile values in:

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/config/models.py`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/runtime/default-profile.toml`

The defaults must use:

- `project_name = "vms-nodes"`
- `pages_project_url = "https://vms-nodes.pages.dev"`

Runtime overrides loaded from profile TOML or environment-backed profile files must continue to win over defaults.

## Testing

- Python unit tests for placeholder rendering success and failure paths.
- Python unit tests for obfuscator flag parity.
- Python unit tests for default deploy values in backend-facing defaults and helper URLs.
- Targeted pipeline/controller tests should continue to pass with the new template.
- After code changes, rerun the relevant unit suite plus the repository-required broader checks before calling the work complete.
