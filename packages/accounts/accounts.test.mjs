import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNTS_DEFAULTS, ACCOUNTS_KEYS } from './settings.mjs';

test('accounts package is optional by default and owns multi-account settings', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'module.json'), 'utf8'));
  assert.equal(manifest.id, 'accounts');
  assert.equal(manifest.defaultInstalled, false);
  assert.equal(ACCOUNTS_DEFAULTS.multiAccount, false);
  assert.ok(ACCOUNTS_KEYS.includes('autoSwitchAccount'));
});
