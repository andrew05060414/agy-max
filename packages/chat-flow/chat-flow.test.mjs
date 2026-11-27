import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAT_FLOW_DEFAULTS, CHAT_FLOW_KEYS } from './settings.mjs';

test('chat-flow package owns inline-images and workbench scripts', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'module.json'), 'utf8'));
  assert.equal(manifest.id, 'chat-flow');
  assert.equal(manifest.defaultInstalled, true);
  assert.equal(existsSync(join(import.meta.dirname, 'native-inline-images.js')), true);
  assert.equal(existsSync(join(import.meta.dirname, 'prism-workbench.js')), true);
  assert.equal(CHAT_FLOW_DEFAULTS.inlineImages, true);
  assert.ok(CHAT_FLOW_KEYS.includes('goalBar'));
});
