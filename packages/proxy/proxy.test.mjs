import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROXY_DEFAULTS, PROXY_KEYS } from './settings.mjs';

test('proxy package is optional by default and owns proxy settings', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'module.json'), 'utf8'));
  assert.equal(manifest.id, 'proxy');
  assert.equal(manifest.defaultInstalled, false);
  assert.equal(PROXY_DEFAULTS.proxyEnabled, false);
  assert.ok(PROXY_KEYS.includes('proxyForceHttp1'));
});
