import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SSH_REMOTE_DEFAULTS, SSH_REMOTE_KEYS } from './settings.mjs';

test('ssh-remote package is optional by default and owns native-ssh-projects.js', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'module.json'), 'utf8'));
  assert.equal(manifest.id, 'ssh-remote');
  assert.equal(manifest.defaultInstalled, false);
  assert.equal(existsSync(join(import.meta.dirname, 'native-ssh-projects.js')), true);
  assert.equal(SSH_REMOTE_DEFAULTS.sshCommandPaste, true);
  assert.deepEqual(SSH_REMOTE_KEYS, ['sshCommandPaste']);
});
