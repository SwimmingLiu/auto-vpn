import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWindowOptions } from '../window-config.js';

test('buildWindowOptions defaults to a half-screen-friendly desktop window', () => {
  const options = buildWindowOptions('/tmp/preload.js', { width: 1728, height: 1065 });

  assert.equal(options.width, 1480);
  assert.equal(options.height, 852);
  assert.equal(options.minWidth, 880);
  assert.equal(options.minHeight, 640);
  assert.equal(options.useContentSize, true);
  assert.equal(options.center, true);
  assert.equal(options.titleBarStyle, 'hidden');
  assert.equal(options.fullscreen, false);
  assert.equal(options.maximizable, true);
  assert.equal(options.webPreferences.preload, '/tmp/preload.js');
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
});

test('buildWindowOptions caps very large displays and respects smaller displays', () => {
  const large = buildWindowOptions('/tmp/preload.js', { width: 3024, height: 1964 });
  const small = buildWindowOptions('/tmp/preload.js', { width: 1100, height: 760 });

  assert.equal(large.width, 1480);
  assert.equal(large.height, 860);
  assert.equal(small.width, 946);
  assert.equal(small.height, 640);
  assert.equal(large.fullscreen, false);
  assert.equal(small.fullscreen, false);
});
