import test from 'node:test';
import assert from 'node:assert/strict';
import { planMacKeychainWrite, SECURITY_LINE_BUDGET, writeMacGenericPassword } from '../lib/mac-keychain.mjs';
import { createSshCredentialVault } from '../lib/ssh-vault.mjs';

const plan = secret => planMacKeychainWrite({ service: 'agy-max-ssh-host', account: 'host-1', buf: Buffer.from(secret, 'utf8') });

test('mac keychain writer keeps every security -i line under the 4096-byte buffer', () => {
  const small = plan('a'.repeat(100));
  assert.equal(small.tier, 'hex');
  assert.deepEqual(small.args, ['-i']);

  const json = JSON.stringify({ token: 'y'.repeat(2500), email: 'a@b.co' });
  const mid = plan(json);
  assert.equal(mid.tier, 'text');
  assert.ok(mid.input.includes(`-w '${json}'`));

  for (const p of [small, mid]) assert.ok(Buffer.byteLength(p.input) < SECURITY_LINE_BUDGET);

  // Quotes, backslashes, non-ASCII and oversized payloads go through JXA on stdin
  for (const secret of ["q'".repeat(1500), 'b\\'.repeat(1500), '密'.repeat(1500), 'z'.repeat(20000)]) {
    const p = plan(secret);
    assert.equal(p.tier, 'jxa', secret.slice(0, 4));
    assert.equal(p.command, '/usr/bin/osascript');
    assert.ok(p.args.every(a => a.length < 64), 'secret must never be in argv');
    assert.ok(p.input.includes(Buffer.from(secret).toString('base64')));
    assert.ok(p.input.includes('teamid:EQHXZ8M8AV'), 'partition ACL from powertools v2.16.10');
  }
});

test('mac keychain writer reports split commands and spawn errors as failures', () => {
  const calls = [];
  const ok = writeMacGenericPassword({ service: 's', account: 'a', buf: Buffer.from('pw'), runSpawn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stderr: '' }; } });
  assert.deepEqual(ok, { ok: true, tier: 'hex' });
  assert.deepEqual(calls[0].opts.stdio, ['pipe', 'ignore', 'pipe']);

  const split = writeMacGenericPassword({ service: 's', account: 'a', buf: Buffer.from('pw'), runSpawn: () => ({ status: 0, stderr: 'security: unknown command "6162"' }) });
  assert.equal(split.ok, false);
  const failed = writeMacGenericPassword({ service: 's', account: 'a', buf: Buffer.from('pw'), runSpawn: () => ({ status: 1, stderr: 'denied' }) });
  assert.deepEqual(failed, { ok: false, tier: 'hex', error: 'denied' });
  const errored = writeMacGenericPassword({ service: 's', account: 'a', buf: Buffer.from('pw'), runSpawn: () => ({ error: new Error('ETIMEDOUT') }) });
  assert.equal(errored.error, 'ETIMEDOUT');
});

test('ssh vault stores a 5 KB password on macOS via the JXA tier instead of failing', () => {
  const calls = [];
  const vault = createSshCredentialVault({ platform: 'darwin', runSpawn: (cmd, args, opts) => { calls.push({ cmd, args, input: String(opts?.input || '') }); return { status: 0, stdout: '', stderr: '' }; } });
  const secret = 'p'.repeat(5000);
  assert.deepEqual(vault.savePassword('host-1', secret), { ok: true });
  const write = calls.find(c => c.cmd === '/usr/bin/osascript');
  assert.ok(write, 'expected a JXA write');
  assert.ok(!write.args.join(' ').includes(secret));
  assert.ok(write.input.includes(Buffer.from(secret).toString('base64')));
});
