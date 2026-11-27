import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TELEMETRY_DEFAULTS, TELEMETRY_KEYS } from './settings.mjs';

test('telemetry package owns calendar-vendor.js and single-account quota/speed settings', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'module.json'), 'utf8'));
  assert.equal(manifest.id, 'telemetry');
  assert.equal(manifest.defaultInstalled, true);
  assert.equal(existsSync(join(import.meta.dirname, 'calendar-vendor.js')), true);
  assert.equal(TELEMETRY_DEFAULTS.contextRing, true);
  assert.equal(TELEMETRY_DEFAULTS.speedStats, true);
  assert.ok(TELEMETRY_KEYS.includes('overviewQuota'));
});
