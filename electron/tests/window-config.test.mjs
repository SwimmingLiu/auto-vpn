import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWindowOptions } from '../window-config.js';

test('buildWindowOptions defaults to a half-screen-friendly desktop window', () => {
  const options = buildWindowOptions('/tmp/preload.js');

  assert.equal(options.width, 1280);
  assert.equal(options.height, 860);
  assert.equal(options.minWidth, 880);
  assert.equal(options.minHeight, 640);
  assert.equal(options.useContentSize, true);
  assert.equal(options.center, true);
  assert.equal(options.titleBarStyle, 'hiddenInset');
  assert.equal(options.webPreferences.preload, '/tmp/preload.js');
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
});
