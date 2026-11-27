import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { I18N_DEFAULTS, I18N_KEYS } from './settings.mjs';

test('i18n package owns native-i18n.js and localization settings', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'module.json'), 'utf8'));
  assert.equal(manifest.id, 'i18n');
  assert.equal(manifest.defaultInstalled, true);
  assert.equal(existsSync(join(import.meta.dirname, 'native-i18n.js')), true);
  assert.equal(I18N_DEFAULTS.language, 'zh-CN');
  assert.deepEqual(I18N_KEYS, ['language', 'marketplaceTranslate']);
});
