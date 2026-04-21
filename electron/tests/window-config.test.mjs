import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWindowOptions } from '../window-config.js';

test('buildWindowOptions defaults to a half-screen-friendly desktop window', () => {
  const options = buildWindowOptions('/tmp/preload.js');

  assert.equal(options.width, 1100);
  assert.equal(options.height, 760);
  assert.equal(options.minWidth, 960);
  assert.equal(options.minHeight, 720);
  assert.equal(options.useContentSize, true);
  assert.equal(options.center, true);
  assert.equal(options.titleBarStyle, 'hiddenInset');
  assert.equal(options.webPreferences.preload, '/tmp/preload.js');
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
});
