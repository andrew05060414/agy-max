// End-to-end tests against a real, throwaway OpenSSH server bound to 127.0.0.1.
// Everything lives in a temp dir: the runner reaches sshd through a wrapper that
// forces `-F <temp config>`, and known_hosts is pre-seeded, so ~/.ssh is never read
// or written. Skips cleanly where sshd is missing or cannot run unprivileged.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createSshRunner } from '../lib/ssh-runner.mjs';
import { createRemoteTelemetryBridge } from '../lib/ssh-remote.mjs';

const SSHD = ['/usr/sbin/sshd', '/usr/local/sbin/sshd', '/opt/homebrew/sbin/sshd'].find(p => existsSync(p));
const SFTP = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server', '/usr/lib/ssh/sftp-server'].find(p => existsSync(p));
const ALIAS = 'agy-e2e';
const NOISE = 'RC_NOISE_LINE {"not":"json"';

let env = null;
let skipReason = process.platform === 'win32' ? 'Windows 上不跑真实 sshd' : (!SSHD ? '未找到 sshd' : '');

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const waitForPort = (port, child, ms = 8000) => new Promise(resolve => {
  const deadline = Date.now() + ms;
  const tryOnce = () => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(false);
    const sock = connect(port, '127.0.0.1');
    sock.once('data', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); Date.now() > deadline ? resolve(false) : setTimeout(tryOnce, 100); });
  };
  tryOnce();
});

function keygen(path) {
  const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path], { stdio: 'pipe' });
  if (r.status !== 0) throw new Error(`ssh-keygen failed: ${r.stderr}`);
}

function setRcNoise(on) {
  for (const f of ['.zshenv', '.bashrc', '.profile']) {
    const p = join(env.home, f);
    if (on) writeFileSync(p, `echo '${NOISE}'\n`);
    else rmSync(p, { force: true });
  }
}

before(async () => {
  if (skipReason) return;
  const dir = mkdtempSync(join(tmpdir(), 'agy-e2e-'));
  try {
    const home = join(dir, 'home');
    mkdirSync(join(home, '.gemini', 'antigravity', 'bin'), { recursive: true });
    // The bridge bootstrap tries this path first, so CI does not need node on sshd's PATH.
    symlinkSync(process.execPath, join(home, '.gemini', 'antigravity', 'bin', 'agy-node'));
    keygen(join(dir, 'host_key'));
    keygen(join(dir, 'client_key'));
    writeFileSync(join(dir, 'authorized_keys'), readFileSync(join(dir, 'client_key.pub')));
    chmodSync(join(dir, 'authorized_keys'), 0o600);
    const port = await freePort();
    writeFileSync(join(dir, 'sshd_config'), [
      `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(dir, 'host_key')}`, `PidFile ${join(dir, 'sshd.pid')}`,
      `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`, 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
      'PubkeyAuthentication yes', 'UsePAM no', 'StrictModes no', `SetEnv HOME=${home} AGY_E2E=1`,
      ...(SFTP ? [`Subsystem sftp ${SFTP}`] : []), ''
    ].join('\n'));
    const hostPub = readFileSync(join(dir, 'host_key.pub'), 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
    writeFileSync(join(dir, 'known_hosts'), `[127.0.0.1]:${port} ${hostPub}\n`);
    const sshConfig = join(dir, 'ssh_config');
    writeFileSync(sshConfig, [
      `Host ${ALIAS}`, '  HostName 127.0.0.1', `  Port ${port}`, `  User ${userInfo().username}`,
      `  IdentityFile ${join(dir, 'client_key')}`, '  IdentitiesOnly yes', `  UserKnownHostsFile ${join(dir, 'known_hosts')}`,
      '  GlobalKnownHostsFile /dev/null', '  StrictHostKeyChecking yes', ''
    ].join('\n'));
    for (const bin of ['ssh', 'scp']) {
      const w = join(dir, `${bin}-wrap`);
      writeFileSync(w, `#!/bin/sh\nexec ${bin} -F '${sshConfig}' "$@"\n`);
      chmodSync(w, 0o755);
    }
    const userDataDir = join(dir, 'userdata');
    mkdirSync(userDataDir);
    writeFileSync(join(userDataDir, 'ssh_windows.json'), JSON.stringify({ windows: [{ host: ALIAS, configFile: sshConfig }] }));
    const log = [];
    const sshd = spawn(SSHD, ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
    sshd.stderr.on('data', c => log.push(String(c)));
    if (!(await waitForPort(port, sshd))) {
      try { sshd.kill(); } catch {}
      skipReason = `sshd 无法以非特权方式启动: ${log.join('').trim().split('\n').slice(-2).join(' | ')}`;
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    const host = { id: `e2e-${randomBytes(4).toString('hex')}`, name: ALIAS, host: ALIAS, configAlias: ALIAS, authType: 'key' };
    const runner = createSshRunner({
      env: { ...process.env, ANTIGRAVITY_SSH_BIN: join(dir, 'ssh-wrap'), ANTIGRAVITY_SCP_BIN: join(dir, 'scp-wrap') },
      retryDelayMs: 200
    });
    env = { dir, home, port, sshd, log, host, runner, userDataDir };
  } catch (error) {
    skipReason = `e2e 环境准备失败: ${error.message}`;
    rmSync(dir, { recursive: true, force: true });
  }
});

after(async () => {
  if (!env) return;
  try { await env.runner.disconnect(env.host); } catch {}
  try { env.runner.closeAll(); } catch {}
  env.sshd.kill();
  await new Promise(r => { if (env.sshd.exitCode !== null) r(); else env.sshd.once('exit', r); });
  rmSync(env.dir, { recursive: true, force: true });
});

const guard = t => { if (skipReason) { t.skip(skipReason); return true; } return false; };

async function exerciseRunner() {
  const { runner, host, home } = env;
  const info = await runner.testConnection(host);
  assert.equal(info.ok, true);
  assert.equal(info.homeDir, home);

  const file = `${home}/work/hello.txt`;
  await runner.runCommand(host, { command: `mkdir -p '${home}/work'`, waitMs: 5000 });
  const written = await runner.writeFile(host, file, 'line one\n你好 world\n');
  assert.equal(written.ok, true, JSON.stringify(written));

  const read = await runner.readFile(host, file);
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.match(JSON.stringify(read), /你好 world/);
  assert.doesNotMatch(JSON.stringify(read), /RC_NOISE_LINE/);

  const edited = await runner.editFile(host, file, 'world', 'remote');
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.match(JSON.stringify(await runner.readFile(host, file)), /你好 remote/);

  const listing = await runner.listDir(host, `${home}/work`, '');
  assert.deepEqual(listing.entries.map(e => e.name), ['hello.txt']);

  const run = await runner.runCommand(host, { command: 'printf "%s|%s" "$AGY_E2E" "$(pwd)"; exit 3', cwd: `${home}/work`, waitMs: 5000 });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.exitCode, 3);
  assert.equal(run.running, false);
  // User commands run under sh -l, so profile output is shown like a real terminal would.
  assert.ok(run.output.trim().endsWith(`1|${home}/work`), JSON.stringify(run.output));

  const bg = await runner.runCommand(host, { command: 'sleep 0.3; echo bg-done', background: true });
  assert.equal(bg.running, true, JSON.stringify(bg));
  let status;
  for (let i = 0; i < 30; i++) {
    status = await runner.jobStatus(host, bg.jobId);
    if (status.ok && status.running === false) break;
    await new Promise(r => setTimeout(r, 200));
  }
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.exitCode, 0, JSON.stringify(status));
  assert.match(status.output, /bg-done/);
}

test('real sshd: runner file and command round trip', { timeout: 60000 }, async t => {
  if (guard(t)) return;
  setRcNoise(false);
  await exerciseRunner();
});

test('real sshd: scp upload and download keep bytes intact', { timeout: 60000 }, async t => {
  if (guard(t)) return;
  if (!SFTP) return t.skip('未找到 sftp-server');
  setRcNoise(false);
  const { runner, host, home, dir } = env;
  const payload = Buffer.concat([randomBytes(70000), Buffer.from('\n尾部\n')]);
  const local = join(dir, 'up.bin');
  writeFileSync(local, payload);
  const up = await runner.transfer(host, { direction: 'upload', localPath: local, remotePath: `${home}/up.bin` });
  assert.equal(up.ok, true, JSON.stringify(up));
  const back = join(dir, 'down.bin');
  const down = await runner.transfer(host, { direction: 'download', localPath: back, remotePath: `${home}/up.bin` });
  assert.equal(down.ok, true, JSON.stringify(down));
  assert.ok(readFileSync(back).equals(payload));
});

test('real sshd: runner survives shell rc files that print on startup', { timeout: 60000 }, async t => {
  if (guard(t)) return;
  setRcNoise(true);
  try {
    await exerciseRunner();
  } finally {
    setRcNoise(false);
  }
});

test('real sshd: telemetry bridge boots the remote worker through noisy rc files', { timeout: 60000 }, async t => {
  if (guard(t)) return;
  setRcNoise(true);
  const bridge = createRemoteTelemetryBridge({ userDataDir: env.userDataDir, connectTimeoutMs: 20000, requestTimeoutMs: 20000 });
  try {
    const dash = await bridge.dashboard(ALIAS, { force: true });
    assert.ok(dash && typeof dash === 'object', JSON.stringify(dash));
    const search = await bridge.search(ALIAS, { query: 'nothing-here' });
    assert.ok(search && typeof search === 'object');
  } finally {
    await bridge.close();
    setRcNoise(false);
  }
});
