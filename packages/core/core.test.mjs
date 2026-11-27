import test from 'node:test';
import assert from 'node:assert/strict';
import { createHookBus } from './hook-bus.mjs';
import { ALL_MODULE_IDS, DEFAULT_MODULE_IDS, OPTIONAL_MODULE_IDS, detectLegacyUsedOptionalModules } from './catalog.mjs';

test('core catalog partitions 8 modules into 4 default and 4 optional without overlapping settings keys', () => {
  assert.equal(ALL_MODULE_IDS.length, 8);
  assert.deepEqual(DEFAULT_MODULE_IDS, ['telemetry', 'chat-flow', 'workspace-nav', 'i18n']);
  assert.deepEqual(OPTIONAL_MODULE_IDS, ['optics', 'accounts', 'proxy', 'ssh-remote']);
  assert.deepEqual(detectLegacyUsedOptionalModules({}), []);
  assert.deepEqual(
    detectLegacyUsedOptionalModules({ themePalette: 'obsidian', proxyEnabled: true }, { hasSavedAccounts: true, hasSavedSsh: true }).sort(),
    ['accounts', 'optics', 'proxy', 'ssh-remote']
  );
});

test('HookBus runs prioritized pipelines and unloads a single module without disturbing sibling modules', async () => {
  const bus = createHookBus();
  const calls = [];
  bus.on('beforeSend', 'chat-flow', val => `${val}+chat`, { priority: 20 });
  bus.on('beforeSend', 'optics', val => `${val}+optics`, { priority: 10 });
  bus.registerRpc('accounts', 'accounts.', req => ({ ok: true, m: req.method }));
  bus.onUnload('optics', () => calls.push('optics-disposed'));

  assert.equal(bus.runSync('beforeSend', 'msg'), 'msg+optics+chat');
  assert.deepEqual(await bus.dispatchRpc('accounts.list', { method: 'accounts.list' }), { handled: true, moduleId: 'accounts', reply: { ok: true, m: 'accounts.list' } });

  await bus.unload('optics');
  assert.deepEqual(calls, ['optics-disposed']);
  assert.equal(bus.runSync('beforeSend', 'msg'), 'msg+chat');
  assert.equal(bus.canHandleRpc('accounts.list'), true);
});
