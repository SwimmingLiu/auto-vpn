# Electron Run/Results/Subscription Stability Design

## Goal

Fix renderer flicker and lost clicks during pipeline execution, remove duplicated page controls and repeated page descriptions, expose a unified source iteration setting, and make the results page show the final usable nodes instead of low-value artifact metadata.

## Current evidence

- Pipeline log and stage events call `appendLog()` or `handlePipelineEvent()` in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`.
- `appendLog()` calls `renderAll()`.
- `renderAll()` replaces both `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/index.html` chrome action content and the active page body through `innerHTML`.
- While the pointer is down on a button, an incoming event can replace the button node before mouseup. Browser click synthesis is then lost.
- A Playwright reproduction against the renderer showed 8 log events replacing the run-page start button 8 times, and an interleaved event between mousedown and mouseup produced `runCalls: 0`.

## Renderer stability

The renderer will stop doing full-page rebuilds for high-frequency runtime updates.

- Page navigation, tab changes, and drawer open/close can still rebuild the active page.
- Log append operations will update only the log containers that are currently visible.
- Stage/status updates will refresh only chrome state and the active run/status regions when needed.
- Buttons must not be replaced by log events while the user is interacting with them.
- The run and stop handlers will keep the existing `state.runState` guard so duplicate backend invocations are still blocked.

## Page structure cleanup

Every page will have one description source: the top chrome `h1` and subtitle.

- Remove the repeated `page-header-card` title block from `buildPageMarkup()`.
- Keep page content focused on the page-specific controls and data.
- Keep the left navigation and top status badge unchanged.

## Run page

The run page will only contain run-specific controls and progress.

- Remove the duplicate topbar run controls for the run page.
- Keep one primary control panel in the run page body with start, stop, and retry.
- Ensure those body controls honor the same disabled state as the topbar previously used.
- Remove the recent-log panel from the run page because the app already has a dedicated logs page.
- Keep run options in the run page body.

## Settings page

The data source drawer will expose one unified max-iteration setting.

- Add a numeric field labeled `最大迭代次数` at the top of the data source drawer.
- The displayed value will be the common value when all sources match.
- If existing source values differ, display the first available source value and normalize all sources to the edited value on save.
- Saving the source drawer writes the unified value into every `source.max_iterations`.
- The backend profile format remains unchanged: each source still stores `max_iterations`, which keeps the current extract pipeline compatible.

## Results page

The results page will show final nodes left after the pipeline.

- Artifact metadata is demoted or removed from the main content.
- Preview source priority:
  1. `vpn_node_emoji.txt`
  2. `vpn_node_availability.txt`
  3. `vpn_node_speedtest.txt`
- Decode each `vmess://` link and return normalized rows:
  - sequence number
  - node name from `ps`
  - IP/address from `add`
  - protocol as `vmess`
  - path from `path`
  - original link for copy operations
- Invalid or unsupported links are skipped from the decoded node table but do not break artifact preview.
- Region statistics are derived from the decoded node name prefix when present, for example `🇺🇸 US example` becomes `US`.
- The page shows region counts as cards and a node table listing all decoded final nodes.
- Copy nodes copies the final links currently displayed in the decoded table.

## Subscription page

The subscription page will remove duplicated topbar actions and make subscription formats primary tabs.

- Remove topbar `复制链接` and `打开订阅` actions.
- Render the format tabs above the active subscription URL.
- Use a horizontally scrollable tab area so the selected tab has an obvious sliding/active effect.
- Keep copy/open actions inside the subscription card and tied to the active tab URL.
- Keep QR refresh behavior when switching formats.

## Tests and verification

Add or update tests before production code changes.

- Electron unit/state tests:
  - vmess preview decoding returns node name, address, protocol, and path.
  - region aggregation counts decoded rows.
  - source drawer unified max-iteration draft logic normalizes all sources on save.
- Renderer e2e tests:
  - log events no longer replace the run-page start button.
  - interleaved mousedown/log/mouseup on the run button still starts the pipeline.
  - run page has one visible start/stop/retry control set.
  - run page no longer renders the recent-log panel.
  - results page shows decoded final nodes and region cards.
  - subscriptions topbar has no duplicate copy/open controls, and format tabs remain above the URL.
  - page body does not render the repeated page header card.
- Visual regression hashes must be refreshed after the intentional UI changes.

## Non-goals

- Do not change the backend extraction algorithm.
- Do not change the TOML profile shape.
- Do not add per-source max-iteration UI.
- Do not replace the existing Electron IPC architecture.
