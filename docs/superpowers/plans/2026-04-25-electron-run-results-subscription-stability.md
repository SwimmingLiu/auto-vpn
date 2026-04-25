# Electron Run/Results/Subscription Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize renderer interactions during pipeline events and update run, settings, results, subscription, and repeated page description UX.

**Architecture:** Keep the existing Electron renderer structure but separate high-frequency runtime updates from full page rebuilds. Add artifact preview decoding in the main-process IPC layer and render final decoded nodes plus region summary in the results page.

**Tech Stack:** Electron, browser DOM APIs, Node.js test runner, Playwright, Python backend profile models.

---

## File map

- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
  - Add stable runtime rendering helpers.
  - Stop log appends from rebuilding the whole page.
  - Add source iteration draft normalization.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`
  - Remove duplicate page header cards.
  - Remove duplicated topbar actions.
  - Update run, settings, results, and subscriptions markup.
  - Export pure helpers for result region stats and source iteration drafts.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/ipc.js`
  - Decode final `vmess://` artifact rows for preview.
  - Prefer final pipeline output files.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/styles.css`
  - Add tab scroller, result stats, stable run/results layout styles.
  - Remove or de-emphasize styles for removed panels.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs`
  - Add pure helper tests for regions and unified max iteration.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/backend.test.mjs`
  - Add artifact preview decoding tests.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`
  - Add interaction stability and UI cleanup tests.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-visual.test.mjs`
  - Refresh expected hashes after visual changes.

---

### Task 1: Add failing tests for artifact preview decoding

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/backend.test.mjs`
- Later modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/ipc.js`

- [ ] **Step 1: Export preview helpers from IPC**

Add imports in the test expecting named helpers:

```js
import { previewArtifactDirectory, parseVmessLinkForPreview } from '../ipc.js';
```

- [ ] **Step 2: Write failing vmess decode test**

Add a test that uses a generated vmess payload:

```js
test('parseVmessLinkForPreview decodes node fields for results page', () => {
  const payload = {
    v: '2',
    ps: '🇺🇸 US demo-node',
    add: '1.2.3.4',
    port: '443',
    id: '00000000-0000-0000-0000-000000000000',
    aid: '0',
    net: 'ws',
    type: 'none',
    host: 'example.invalid',
    path: '/edge',
    tls: 'tls'
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

  assert.deepEqual(parseVmessLinkForPreview(`vmess://${encoded}`), {
    name: '🇺🇸 US demo-node',
    address: '1.2.3.4',
    protocol: 'vmess',
    path: '/edge',
    link: `vmess://${encoded}`
  });
});
```

- [ ] **Step 3: Write failing artifact preview priority test**

Create a temp artifact dir with `vpn_node_speedtest.txt`, `vpn_node_availability.txt`, and `vpn_node_emoji.txt`. Assert `previewArtifactDirectory()` chooses the emoji file and returns decoded rows.

- [ ] **Step 4: Run red test**

Run:

```bash
rtk node --test electron/tests/backend.test.mjs
```

Expected: FAIL because the helpers are not exported.

- [ ] **Step 5: Implement minimal IPC helpers**

Add pure helpers:

```js
export function parseVmessLinkForPreview(link) {
  const value = String(link ?? '').trim();
  if (!value.startsWith('vmess://')) return null;
  try {
    const encoded = value.slice('vmess://'.length);
    const payload = JSON.parse(Buffer.from(padBase64(encoded), 'base64url').toString('utf8'));
    return {
      name: String(payload.ps ?? ''),
      address: String(payload.add ?? ''),
      protocol: 'vmess',
      path: String(payload.path ?? ''),
      link: value
    };
  } catch {
    return null;
  }
}
```

Add `previewArtifactDirectory(resolved)` and call it from the existing `artifact:preview` handler.

- [ ] **Step 6: Run green test**

Run:

```bash
rtk node --test electron/tests/backend.test.mjs
```

Expected: PASS.

---

### Task 2: Add failing pure renderer tests for region stats and source iteration drafts

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs`
- Later modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`

- [ ] **Step 1: Import new helpers**

```js
import {
  buildRegionStats,
  buildSourceIterationDraft,
  applySourceIterationDraft,
  classifyLogEntry,
  filterLogEntries,
  groupLogEntriesByStage
} from '../renderer/views.js';
```

- [ ] **Step 2: Add failing region stats test**

```js
test('buildRegionStats counts decoded vmess rows by region prefix', () => {
  const stats = buildRegionStats([
    { name: '🇺🇸 US alpha' },
    { name: '🇺🇸 US beta' },
    { name: '🇯🇵 JP tokyo' },
    { name: 'plain node' }
  ]);

  assert.deepEqual(stats, [
    { region: 'US', count: 2 },
    { region: 'JP', count: 1 },
    { region: '其他', count: 1 }
  ]);
});
```

- [ ] **Step 3: Add failing source iteration draft test**

```js
test('source iteration draft applies one max_iterations value to all sources', () => {
  const sources = {
    leiting: { url: 'https://a.example', key: 'a', enabled: true, max_iterations: 12 },
    heidong: { url: 'https://b.example', key: 'b', enabled: true, max_iterations: 40 }
  };
  const draft = buildSourceIterationDraft(sources);

  assert.equal(draft.maxIterations, 12);
  draft.maxIterations = 25;

  assert.deepEqual(
    Object.values(applySourceIterationDraft(sources, draft)).map((source) => source.max_iterations),
    [25, 25]
  );
});
```

- [ ] **Step 4: Run red test**

Run:

```bash
rtk node --test electron/tests/ui-state.test.mjs
```

Expected: FAIL because helpers are not exported.

- [ ] **Step 5: Implement helpers in `views.js`**

Add pure exports:

```js
export function buildRegionStats(nodeRows = []) { ... }
export function buildSourceIterationDraft(sources = {}) { ... }
export function applySourceIterationDraft(sources = {}, draft = {}) { ... }
```

Use simple region parsing: first two uppercase letters after an optional emoji prefix; fallback to `其他`.

- [ ] **Step 6: Run green test**

Run:

```bash
rtk node --test electron/tests/ui-state.test.mjs
```

Expected: PASS.

---

### Task 3: Add failing renderer e2e tests for stability and UI cleanup

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`
- Later modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- Later modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`

- [ ] **Step 1: Extend mock preview data**

Make `previewArtifact` return:

```js
{
  ok: true,
  outputFiles: [],
  nodeRows: [
    {
      name: '🇺🇸 US demo-node',
      address: '1.2.3.4',
      protocol: 'vmess',
      path: '/edge',
      link: 'vmess://demo'
    }
  ]
}
```

- [ ] **Step 2: Add failing no-replacement test**

On the run page, observe `#runsWorkspace [data-run-action=start]`, emit repeated log events, and assert the same element remains connected.

- [ ] **Step 3: Add failing interleaved click test**

Use mouse down on the run button, emit one log event, then mouse up. Assert the mocked `runPipeline` call count is `1`.

- [ ] **Step 4: Add failing UI cleanup assertions**

Assert:

```js
assert.equal(await page.locator('.page-header-card').count(), 0);
assert.equal(await page.locator('[data-run-action="start"]').count(), 1);
assert.equal(await page.locator('[data-run-action="stop"]').count(), 1);
assert.equal(await page.locator('[data-action="retry-current-stage"]').count(), 1);
assert.equal(await page.locator('#runsLogOutput').count(), 0);
```

- [ ] **Step 5: Add failing results/subscription assertions**

Assert decoded results show `demo-node`, `1.2.3.4`, `vmess`, `/edge`, and a `US` region card. Assert subscription topbar no longer contains copy/open buttons while the subscription card still does.

- [ ] **Step 6: Run red test**

Run:

```bash
rtk node --test electron/tests/renderer-e2e.test.mjs
```

Expected: FAIL with current duplicate buttons and replacement behavior.

---

### Task 4: Implement stable runtime rendering and page cleanup

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`

- [ ] **Step 1: Make `appendLog()` local**

Change `appendLog()` so it pushes the classified log entry, updates timestamps, and calls `renderRuntimeOnly()` instead of `renderAll()`.

- [ ] **Step 2: Add runtime rendering helpers**

Add:

```js
function renderRuntimeOnly() {
  const messages = getMessages(state.language);
  const viewModel = buildViewModel(state, messages, state.language);
  renderChrome(messages, viewModel);
  renderActiveRuntimeSections(viewModel);
}
```

`renderActiveRuntimeSections()` updates visible log containers, stage/current-stage panels, and result counts without replacing active buttons.

- [ ] **Step 3: Keep full rebuilds for structural actions**

Keep `renderAll()` for page navigation, drawer open/close, tab switches, and completed artifact hydration.

- [ ] **Step 4: Remove topbar duplicate actions**

In `buildTopbarActions()`, return no topbar actions for `runs`, `results`, and `subscriptions`.

- [ ] **Step 5: Remove body page header card**

Change `buildPageMarkup()` to return only:

```js
return `
  <section class="page-shell" data-page-shell="${activePage}">
    ${buildPageInner(activePage, viewModel, messages, language, subtabs)}
  </section>
`;
```

- [ ] **Step 6: Update run page markup**

Remove the terminal recent-log panel and ensure button disabled attributes are computed from the current run state.

- [ ] **Step 7: Run renderer e2e green check**

Run:

```bash
rtk node --test electron/tests/renderer-e2e.test.mjs
```

Expected: PASS.

---

### Task 5: Implement settings, results, and subscription UI

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/styles.css`

- [ ] **Step 1: Add unified max-iteration drawer field**

In source drawer markup, add:

```html
<label class="field compact source-iteration-field">
  <span>最大迭代次数</span>
  <input type="number" min="1" data-source-max-iterations value="..." />
</label>
```

- [ ] **Step 2: Handle unified max-iteration input**

In `handleDocumentInput()`, detect `[data-source-max-iterations]` and update the drawer draft's unified value.

- [ ] **Step 3: Apply unified value on drawer save**

In `saveSettingsDrawer()`, when `section === 'sources'`, call `applySourceIterationDraft()` before assigning back to `state.profile.sources`.

- [ ] **Step 4: Replace results page content**

Render `vm.regionStats` cards followed by the decoded node table with `#`, `节点名称`, `IP地址`, `协议`, `path`.

- [ ] **Step 5: Replace subscription format row with top tab scroller**

Move format tabs above `.subscription-primary` and wrap them in `.subscription-tab-scroller`.

- [ ] **Step 6: Add CSS**

Add styles for `.subscription-tab-scroller`, `.region-stat-grid`, `.region-stat-card`, `.decoded-node-table`, and adjusted run/results grids.

- [ ] **Step 7: Run targeted tests**

Run:

```bash
rtk node --test electron/tests/ui-state.test.mjs electron/tests/renderer-e2e.test.mjs
```

Expected: PASS.

---

### Task 6: Refresh visual regression and run full verification

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-visual.test.mjs`

- [ ] **Step 1: Run visual test to collect new digests**

Run:

```bash
rtk node --test electron/tests/renderer-visual.test.mjs
```

Expected: FAIL with new digest values because the UI changed intentionally.

- [ ] **Step 2: Update expected digests**

Copy the actual digest object from the failure into `EXPECTED_DIGESTS`.

- [ ] **Step 3: Run full test suite**

Run:

```bash
rtk npm run test:all
```

Expected: PASS.

- [ ] **Step 4: Run package check**

Run:

```bash
rtk npm run package:electron
```

Expected: PASS and output under `/Users/swimmingliu/data/VPN/vpn-subscription-automation/dist-electron`.

- [ ] **Step 5: Capture updated screenshots**

Run:

```bash
rtk node capture_screenshots.mjs
```

Expected: regenerated screenshots under `/Users/swimmingliu/data/VPN/vpn-subscription-automation/artifacts/screenshots`.

- [ ] **Step 6: Prepare PR**

After tests pass, commit only the files touched by this task, push a branch, and open a GitHub PR. Do not request `@Copilot` automatically because the repository-local AGENTS.md overrides the parent instruction.
