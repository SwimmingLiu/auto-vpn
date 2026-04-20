# Electron Compact Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Electron renderer into a compact, half-screen-first dashboard that fits inside a 960x720 MacBook window without developer-facing copy or clipped panels.

**Architecture:** Keep the existing single-page Electron renderer, but tighten the information hierarchy around a short summary band, a compact 2x2 summary grid, and a right-hand status/log rail. The behavior stays in `electron/renderer/app.js`; copy stays in `electron/renderer/i18n.js`; layout changes stay in `electron/renderer/styles.css`; regression coverage stays in the existing `node:test` + Playwright tests.

**Tech Stack:** Electron, HTML, CSS, JavaScript, node:test, Playwright

---

### Task 1: Lock the compact dashboard contract with failing tests

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs`

- [ ] **Step 1: Write the failing test for 960x720 compact layout and copy rules**

```javascript
test('renderer fits the compact dashboard contract at 960x720', async () => {
  const server = await startStaticServer(path.join(__dirname, '..', 'renderer'));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });

  await page.addInitScript(() => {
    window.localStorage.setItem('vpn-automation-language', 'zh-CN');
  });
  await page.goto(`${server.origin}/index.html`);
  await page.waitForSelector('.dashboard-shell');

  const summaryCards = await page.locator('.summary-card').count();
  const heroBody = await page.locator('#heroBody').innerText();
  const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const innerHeight = await page.evaluate(() => window.innerHeight);
  const innerWidth = await page.evaluate(() => window.innerWidth);

  assert.equal(summaryCards, 4);
  assert.doesNotMatch(heroBody, /不必全屏|展开式抽屉查看/);
  assert.ok(scrollHeight <= innerHeight + 2);
  assert.ok(scrollWidth <= innerWidth + 2);
});
```

- [ ] **Step 2: Run the e2e test to verify it fails for the current layout**

Run: `node --test electron/tests/renderer-e2e.test.mjs`
Expected: FAIL because the current renderer still renders 3 summary cards and the old hero-based layout selectors.

- [ ] **Step 3: Add a narrow unit test for the new compact copy**

```javascript
test('getMessages exposes compact dashboard copy without developer-facing hints', () => {
  const zh = getMessages('zh-CN');
  const en = getMessages('en-US');

  assert.match(zh.heroTitle, /节点抓取/);
  assert.doesNotMatch(zh.heroBody, /全屏|抽屉/);
  assert.match(en.heroTitle, /capture/i);
  assert.doesNotMatch(en.heroBody, /fullscreen|drawer/i);
});
```

- [ ] **Step 4: Run the unit test to verify it fails**

Run: `node --test electron/tests/ui-state.test.mjs`
Expected: FAIL because the current copy still describes the broader hero layout rather than the compact summary wording.

- [ ] **Step 5: Commit the red tests**

```bash
git add electron/tests/renderer-e2e.test.mjs electron/tests/ui-state.test.mjs
git commit -m "test: define compact dashboard contract"
```

### Task 2: Implement the compact summary structure and product copy

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/index.html`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/i18n.js`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs`

- [ ] **Step 1: Replace the hero-first markup with a compact dashboard shell**

```html
<div class="app-frame">
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark"></div>
        <div>
          <div id="appTitle" class="brand-title"></div>
          <div id="brandSubtitle" class="brand-subtitle"></div>
        </div>
      </div>
      <div class="topbar-actions">
        <label class="language-control">
          <span id="languageLabel"></span>
          <select id="languageSelect">
            <option value="zh-CN">中文</option>
            <option value="en-US">English</option>
          </select>
        </label>
        <button id="saveBtn" class="btn btn-secondary"></button>
        <button id="runBtn" class="btn btn-primary"></button>
      </div>
    </header>
    <section class="dashboard-shell">
      <section class="overview-panel">
        <div class="overview-copy">
          <div id="eyebrow" class="eyebrow"></div>
          <h1 id="heroTitle"></h1>
          <p id="heroBody"></p>
        </div>
        <div id="metricsRibbon" class="metrics-ribbon"></div>
      </section>

      <section class="workspace-grid">
        <div class="summary-grid">
          <article class="summary-card" data-card="sources">
            <div class="summary-card-top">
              <div>
                <h2 id="sourcesCardTitle"></h2>
                <p id="sourcesCardSubtitle" class="summary-muted"></p>
              </div>
              <button class="ghost-btn" data-panel="sources" id="sourcesExpandBtn"></button>
            </div>
            <div id="sourcesSummary" class="summary-body"></div>
          </article>
          <article class="summary-card" data-card="speed">
            <div class="summary-card-top">
              <div>
                <h2 id="speedCardTitle"></h2>
                <p id="speedCardSubtitle" class="summary-muted"></p>
              </div>
              <button class="ghost-btn" data-panel="speed" id="speedExpandBtn"></button>
            </div>
            <div id="speedSummary" class="summary-body"></div>
          </article>
          <article class="summary-card" data-card="deploy">
            <div class="summary-card-top">
              <div>
                <h2 id="deployCardTitle"></h2>
                <p id="deployCardSubtitle" class="summary-muted"></p>
              </div>
              <button class="ghost-btn" data-panel="deploy" id="deployExpandBtn"></button>
            </div>
            <div id="deploySummary" class="summary-body"></div>
          </article>
          <article class="summary-card" data-card="metrics">
            <div class="summary-card-top">
              <div>
                <h2 id="metricsCardTitle"></h2>
                <p id="metricsCardSubtitle" class="summary-muted"></p>
              </div>
            </div>
            <div id="metricsSummary" class="summary-body"></div>
          </article>
        </div>

        <aside class="status-column">
          <section class="panel-card">
            <div class="panel-head">
              <h2 id="stagesTitle"></h2>
              <span id="stagesSubtitle" class="panel-muted"></span>
            </div>
            <div id="stages" class="stage-list"></div>
          </section>
          <section class="panel-card logs-card">
            <div class="panel-head">
              <h2 id="logsTitle"></h2>
              <span id="logsSubtitle" class="panel-muted"></span>
            </div>
            <pre id="logOutput" class="log-output"></pre>
          </section>
        </aside>
      </section>
    </section>
  </div>
</div>
```

- [ ] **Step 2: Update renderer bindings and summary rendering for the fourth card**

```javascript
const elements = {
  appTitle: document.querySelector('#appTitle'),
  brandSubtitle: document.querySelector('#brandSubtitle'),
  metricsCardTitle: document.querySelector('#metricsCardTitle'),
  metricsCardSubtitle: document.querySelector('#metricsCardSubtitle'),
  metricsSummary: document.querySelector('#metricsSummary'),
  sourcesSummary: document.querySelector('#sourcesSummary'),
  speedSummary: document.querySelector('#speedSummary'),
  deploySummary: document.querySelector('#deploySummary')
};

function renderSummaryCards() {
  const m = getMessages(state.language);
  const sources = Object.values(state.profile.sources);
  elements.metricsSummary.innerHTML = [
    createSummaryLine(formatMessage(m.summaryRawLinks, { count: state.counts.raw_links ?? 0 })),
    createSummaryLine(formatMessage(m.summarySpeedPassed, { count: state.counts.speedtest_links ?? 0 })),
    createSummaryLine(formatMessage(m.summaryVerifyState, {
      status: m.statusLabels[state.stageStatus.verify ?? 'pending']
    }))
  ].join('');
  elements.sourcesSummary.innerHTML = [
    createSummaryLine(formatMessage(m.summaryEnabledSources, {
      count: sources.filter((item) => item.enabled).length,
      total: sources.length
    }))
  ].join('');
}
```

- [ ] **Step 3: Rewrite i18n copy so the page only describes product features**

```javascript
'zh-CN': {
  brandSubtitle: '紧凑桌面控制台',
  heroTitle: '紧凑查看节点抓取、测速、部署与运行状态',
  heroBody: '在一个控制台里维护抓包源、测速阈值和发布配置，并持续查看阶段进度与日志摘要。',
  metricsCardTitle: '运行指标',
  metricsCardSubtitle: '摘要 / 校验 / 吞吐',
  summaryRawLinks: '原始节点 {count}',
  summarySpeedPassed: '测速通过 {count}',
  summaryVerifyState: '校验状态 {status}'
}
```

- [ ] **Step 4: Run the red tests again and verify they pass**

Run: `node --test electron/tests/ui-state.test.mjs electron/tests/renderer-e2e.test.mjs`
Expected: PASS for the compact copy assertions and the four-card DOM contract.

- [ ] **Step 5: Commit the structure and copy changes**

```bash
git add electron/renderer/index.html electron/renderer/app.js electron/renderer/i18n.js electron/tests/renderer-e2e.test.mjs electron/tests/ui-state.test.mjs
git commit -m "feat: compact the dashboard structure and copy"
```

### Task 3: Tighten layout sizing, centered half-screen width, and drawer behavior

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/styles.css`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`

- [ ] **Step 1: Extend the e2e test with drawer-boundary checks**

```javascript
await page.locator('[data-panel="sources"]').click();
await page.waitForSelector('.drawer.open');

const drawerBox = await page.locator('.drawer.open').boundingBox();
assert.ok(drawerBox.width < 400);
assert.ok(drawerBox.x >= 0);
assert.ok(drawerBox.x + drawerBox.width <= 960);
```

- [ ] **Step 2: Run the e2e test to verify the current drawer/layout still fails**

Run: `node --test electron/tests/renderer-e2e.test.mjs`
Expected: FAIL because the current shell uses full-window spacing and a wider drawer treatment.

- [ ] **Step 3: Implement compact CSS with a centered frame and lower-density spacing**

```css
body {
  overflow: auto;
  padding: 16px;
}

.app-frame {
  min-height: 100%;
  display: flex;
  justify-content: center;
}

.app-shell {
  width: min(100%, clamp(780px, 54vw, 1100px));
  min-height: calc(100vh - 32px);
  gap: 12px;
  padding: 12px;
}

.workspace-grid {
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 12px;
}

.summary-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.drawer {
  width: min(360px, calc(100vw - 40px));
  right: 20px;
}

@media (max-width: 980px) {
  .workspace-grid {
    grid-template-columns: minmax(0, 1fr) 260px;
  }
}

@media (max-width: 860px) {
  .workspace-grid,
  .overview-panel {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 4: Re-run the e2e test to verify the compact layout passes at 960x720**

Run: `node --test electron/tests/renderer-e2e.test.mjs`
Expected: PASS with no overflow and an in-bounds drawer.

- [ ] **Step 5: Commit the compact responsive layout**

```bash
git add electron/renderer/styles.css electron/tests/renderer-e2e.test.mjs
git commit -m "feat: tighten renderer layout for half-screen windows"
```

### Task 4: Refresh visual regression and run the full Electron verification set

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-visual.test.mjs`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/*.test.mjs`

- [ ] **Step 1: Update the visual regression to capture the compact dashboard viewport**

```javascript
test('renderer visual hash matches compact dashboard layout', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  await page.waitForSelector('.dashboard-shell');
  const digest = crypto.createHash('sha256').update(await page.screenshot()).digest('hex');
  assert.equal(digest, 'ba07745532b04299d5143b6cddd71690015bec497af90bf3bd64670c861ec92a');
});
```

- [ ] **Step 2: Run the visual test once to get the new hash, then update the assertion**

Run: `node --test electron/tests/renderer-visual.test.mjs`
Expected: FAIL with the new screenshot hash printed by the assertion mismatch.

- [ ] **Step 3: Re-run the visual test after updating the expected hash**

Run: `node --test electron/tests/renderer-visual.test.mjs`
Expected: PASS with the compact dashboard snapshot locked.

- [ ] **Step 4: Run the full Electron verification suite**

Run: `npm run test:electron`
Expected: PASS with all renderer/unit/e2e/visual tests green.

- [ ] **Step 5: Commit the regression updates**

```bash
git add electron/tests/renderer-visual.test.mjs
git commit -m "test: refresh compact dashboard visual baseline"
```
