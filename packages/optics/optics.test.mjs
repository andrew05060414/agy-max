import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPTICS_DEFAULTS, OPTICS_KEYS } from './settings.mjs';
import { registerModule } from './service.mjs';
import { createHookBus } from '../core/hook-bus.mjs';

test('optics package owns prism-optics.js, manifest, and isolated settings slice', async () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'module.json'), 'utf8'));
  assert.equal(manifest.id, 'optics');
  assert.equal(manifest.defaultInstalled, false);
  assert.equal(existsSync(join(import.meta.dirname, 'prism-optics.js')), true);
  assert.equal(OPTICS_DEFAULTS.themePalette, 'native');
  assert.ok(OPTICS_KEYS.includes('mascotMode'));
  const bus = createHookBus();
  await registerModule(bus);
  assert.equal(bus.runSync('optics.active', false), true);
});
