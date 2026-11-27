import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_NAV_DEFAULTS, WORKSPACE_NAV_KEYS } from './settings.mjs';

test('workspace-nav package owns aux-file-tree.js and search/git/priority settings', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'module.json'), 'utf8'));
  assert.equal(manifest.id, 'workspace-nav');
  assert.equal(manifest.defaultInstalled, true);
  assert.equal(existsSync(join(import.meta.dirname, 'aux-file-tree.js')), true);
  assert.equal(WORKSPACE_NAV_DEFAULTS.gitStatusPill, true);
  assert.ok(WORKSPACE_NAV_KEYS.includes('sessionSearch'));
});
