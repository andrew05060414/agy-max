import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createSshCredentialVault, sshVaultTarget, withSshAskpass } from '../lib/ssh-vault.mjs';
import { createSshProjectsStore, discoverLocalCapabilities, parseSshConfigHosts, readSshProjectMarker } from '../lib/ssh-projects.mjs';
import { buildScpArgs, buildSshArgs, createSshRunner, makeRemoteUri, parseRemoteUri, shQuote } from '../lib/ssh-runner.mjs';
import { evaluateSshBoundaryHook } from '../lib/ssh-boundary.mjs';
import { collectPackage } from '../lib/package.mjs';

function makeTempDir(prefix = 'agy-ssh-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakeVault() {
  const map = new Map();
  return {
    supported: true,
    savePassword(id, pw) { map.set(id, pw); return { ok: true }; },
    readPassword(id) { return map.has(id) ? { ok: true, exists: true, password: map.get(id) } : { ok: true, exists: false, password: '' }; },
    hasPassword(id) { return map.has(id); },
    removePassword(id) { map.delete(id); return { ok: true }; }
  };
}

function makeMockSpawn(handler) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    let stdinBuf = Buffer.alloc(0);
    child.stdin.write = chunk => { stdinBuf = Buffer.concat([stdinBuf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]); };
    child.stdin.end = chunk => {
      if (chunk) child.stdin.write(chunk);
      queueMicrotask(() => {
        const res = handler({ cmd, args, opts, stdin: stdinBuf.toString('utf8') }) || { code: 0, stdout: '', stderr: '' };
        if (res.stdout) child.stdout.emit('data', Buffer.from(res.stdout, 'utf8'));
        if (res.stderr) child.stderr.emit('data', Buffer.from(res.stderr, 'utf8'));
        child.emit('close', res.code ?? 0);
      });
    };
    child.kill = () => {};
    calls.push({ cmd, args, opts });
    if (opts?.stdio?.[0] === 'ignore') {
      queueMicrotask(() => {
        const res = handler({ cmd, args, opts, stdin: '' }) || { code: 0, stdout: '', stderr: '' };
        if (res.stdout) child.stdout.emit('data', Buffer.from(res.stdout, 'utf8'));
        if (res.stderr) child.stderr.emit('data', Buffer.from(res.stderr, 'utf8'));
        child.emit('close', res.code ?? 0);
      });
    }
    return child;
  };
  fn.calls = calls;
  return fn;
}

test('ssh-vault validates targets, handles darwin/win32/linux backends, and cleans askpass files even on error', async () => {
  assert.equal(sshVaultTarget('host-1'), 'agy-max:ssh-host:host-1');
  assert.throws(() => sshVaultTarget('../bad'), /无效/);

  const darwinCalls = [];
  const darwinVault = createSshCredentialVault({
    platform: 'darwin',
    runSpawn(cmd, args, opts) {
      darwinCalls.push({ cmd, args, input: opts?.input });
      if (args[0] === '-i') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'find-generic-password' && args.includes('-w')) {
        const acct = args[args.indexOf('-a') + 1];
        if (acct === 'host-utf8') return { status: 0, stdout: Buffer.from('密码123').toString('hex') + '\n', stderr: '' };
        return { status: 0, stdout: 's3cr3t\n', stderr: '' };
      }
      if (args[0] === 'find-generic-password') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'delete-generic-password') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    }
  });
  assert.equal(darwinVault.savePassword('host-a', 's3cr3t').ok, true);
  assert.equal(darwinVault.hasPassword('host-a'), true);
  assert.deepEqual(darwinVault.readPassword('host-a'), { ok: true, exists: true, password: 's3cr3t' });
  assert.deepEqual(darwinVault.readPassword('host-utf8'), { ok: true, exists: true, password: '密码123' });
  assert.equal(darwinVault.removePassword('host-a').ok, true);

  const winVault = createSshCredentialVault({
    platform: 'win32',
    runSpawn(_cmd, _args, opts) {
      const op = opts.env.AGY_SSH_CRED_OP;
      if (op === 'write') return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
      if (op === 'read') return { status: 0, stdout: JSON.stringify({ ok: true, exists: true, data: Buffer.from('win-pw').toString('base64') }) + '\n', stderr: '' };
      if (op === 'has') return { status: 0, stdout: '{"ok":true,"exists":true}\n', stderr: '' };
      return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
    }
  });
  assert.equal(winVault.savePassword('host-w', 'win-pw').ok, true);
  assert.equal(winVault.readPassword('host-w').password, 'win-pw');

  const tmp = makeTempDir('agy-askpass-');
  let capturedScript = '';
  try {
    await assert.rejects(
      withSshAskpass('top-secret', async env => {
        capturedScript = env.SSH_ASKPASS;
        assert.equal(env.SSH_ASKPASS_REQUIRE, 'force');
        assert.equal(existsSync(capturedScript), true);
        throw new Error('boom');
      }, { tempRoot: tmp }),
      /boom/
    );
    assert.equal(existsSync(capturedScript), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ssh-projects parses ~/.ssh/config, separates hosts from projects, rebinds while preserving workspace, and deletes safely', () => {
  const tmp = makeTempDir('agy-ssh-store-');
  const fakeHome = join(tmp, 'home');
  mkdirSync(join(fakeHome, '.gemini', 'config', 'skills', 'gpu-train'), { recursive: true });
  writeFileSync(join(fakeHome, '.gemini', 'config', 'skills', 'gpu-train', 'SKILL.md'), '---\nname: gpu-train\ndescription: Train models on GPU\n---\n');
  mkdirSync(join(fakeHome, '.gemini', 'config', 'plugins', 'gmail'), { recursive: true });
  writeFileSync(join(fakeHome, '.gemini', 'config', 'plugins', 'gmail', 'plugin.json'), JSON.stringify({ name: 'gmail', displayName: 'Gmail', description: 'Read mail' }));

  const parsedCfg = parseSshConfigHosts(`
# comment
Host *
  ServerAliveInterval 60

Host autodl-4090
  HostName connect.westb.seetacloud.com
  User root
  Port 11430
  IdentityFile ~/.ssh/id_ed25519
  ProxyJump jump@bastion.example.com
`);
  assert.equal(parsedCfg.length, 1);
  assert.equal(parsedCfg[0].alias, 'autodl-4090');
  assert.equal(parsedCfg[0].port, 11430);
  assert.equal(parsedCfg[0].proxyJump, 'jump@bastion.example.com');

  const vault = makeFakeVault();
  const store = createSshProjectsStore({ dataDir: join(tmp, 'data'), home: fakeHome, vault });

  const hostA = store.upsertHost({ rawCommand: 'ssh -p 23456 root@region-a.autodl.pro', password: 'pw1' });
  assert.equal(hostA.host, 'region-a.autodl.pro');
  assert.equal(hostA.port, 23456);
  assert.equal(hostA.user, 'root');
  assert.equal(hostA.hasPassword, true);
  // Plaintext password must never be written to hosts.json
  assert.equal(readFileSync(join(tmp, 'data', 'hosts.json'), 'utf8').includes('pw1'), false);

  const hostB = store.upsertHost({ host: 'region-b.autodl.pro', port: 34567, user: 'root', authType: 'key', name: 'autodl-new-gpu' });
  const proj = store.createProject({ hostId: hostA.id, remoteDir: '/root/autodl-tmp/exp1', capabilityScope: { mode: 'selected', allowedSkills: ['gpu-train'], allowedPlugins: ['gmail'] } });
  assert.equal(proj.remoteDir, '/root/autodl-tmp/exp1');
  assert.equal(existsSync(proj.proxyWorkspaceDir), true);

  const marker = readSshProjectMarker(proj.proxyWorkspaceDir);
  assert.equal(marker.projectId, proj.id);
  assert.equal(store.findProjectByWorkspace(proj.workspaceUri)?.id, proj.id);

  // Rebinding host preserves project id, nativeProjectId, and proxyWorkspaceDir (chat history intact)
  const rebound = store.rebindProjectHost(proj.id, hostB.id);
  assert.equal(rebound.id, proj.id);
  assert.equal(rebound.proxyWorkspaceDir, proj.proxyWorkspaceDir);
  assert.equal(rebound.hostId, hostB.id);
  assert.equal(readSshProjectMarker(proj.proxyWorkspaceDir).hostId, hostB.id);

  // Cannot delete bound host without force
  assert.throws(() => store.deleteHost(hostB.id), /绑定/);

  // Deleting project removes local marker only and preserves host
  const delRes = store.deleteProject(proj.id);
  assert.equal(delRes.deleted, true);
  assert.equal(delRes.hostPreserved, true);
  assert.equal(existsSync(proj.proxyWorkspaceDir), false);
  assert.ok(store.getHost(hostB.id));

  const caps = discoverLocalCapabilities({ home: fakeHome });
  assert.equal(caps.skills.length, 1);
  assert.equal(caps.skills[0].id, 'gpu-train');
  assert.equal(caps.plugins.some(p => p.id === 'gmail'), true);

  rmSync(tmp, { recursive: true, force: true });
});

test('ssh-runner builds cross-platform args and runs remote commands, detached jobs, files, images, git, and transfers', async () => {
  const tmp = makeTempDir('agy-ssh-runner-');
  const vault = makeFakeVault();
  const store = createSshProjectsStore({ dataDir: join(tmp, 'data'), home: tmp, vault });
  const host = store.upsertHost({ name: 'gpu-1', host: '10.0.0.8', port: 2222, user: 'ubuntu', authType: 'key' });

  const uri = makeRemoteUri(host.id, '/home/ubuntu/论文 实验/loss.png');
  assert.deepEqual(parseRemoteUri(uri), { hostId: host.id, path: '/home/ubuntu/论文 实验/loss.png' });
  assert.equal(shQuote("a'b"), `'a'\\''b'`);

  const macArgs = buildSshArgs(host, { platform: 'darwin', hasPassword: false });
  assert.ok(macArgs.args.includes('ControlMaster=auto'));
  assert.ok(macArgs.args.includes('BatchMode=yes'));
  const winArgs = buildSshArgs(host, { platform: 'win32', hasPassword: true });
  assert.ok(winArgs.args.includes('ControlMaster=no'));
  assert.ok(winArgs.args.includes('BatchMode=no'));
  const scpArgs = buildScpArgs(host, { platform: 'linux', recursive: true });
  assert.ok(scpArgs.args.includes('-r'));
  assert.ok(scpArgs.args.includes('-P'));

  const mockSpawn = makeMockSpawn(({ cmd, args }) => {
    const joined = args.join(' ');
    if (cmd === 'scp') return { code: 0, stdout: '', stderr: '' };
    if (joined.includes('HOSTNAME=')) {
      return { code: 0, stdout: 'HOME=/home/ubuntu\nHOSTNAME=gpu-1\nUNAME=Linux x86_64\nPY3=/usr/bin/python3\nGIT=/usr/bin/git\nRG=/usr/bin/rg\n' };
    }
    if (joined.includes('os.listdir')) {
      return { code: 0, stdout: JSON.stringify({ ok: true, rootDir: '/home/ubuntu/proj', dirPath: '/home/ubuntu/proj', entries: [{ name: 'train.py', path: '/home/ubuntu/proj/train.py', isDirectory: false, size: 120, mtimeMs: 1000 }], truncated: false }) };
    }
    if (joined.includes('is_img')) {
      return { code: 0, stdout: JSON.stringify({ ok: true, kind: 'image', path: '/home/ubuntu/proj/loss.png', name: 'loss.png', size: 4, mtimeMs: 1000, dataBase64: 'AAAA' }) };
    }
    if (joined.includes('__AGY_STATE__')) {
      return { code: 0, stdout: '__AGY_STATE__:RUNNING:4321:-1:/home/ubuntu/proj\nepoch 1 loss=0.42\n' };
    }
    if (joined.includes('__AGY_JOB__')) {
      return { code: 0, stdout: '__AGY_JOB__:RUNNING:4321:-1:1700000000:/home/ubuntu/proj\nepoch 5 loss=0.12\n' };
    }
    if (joined.includes('__TOP__:')) {
      return { code: 0, stdout: '__TOP__:/home/ubuntu/proj\n## main...origin/main [ahead 1]\n M train.py\n?? plot.png\n' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });

  const runner = createSshRunner({ store, spawnProcess: mockSpawn, platform: 'darwin', home: tmp });
  const testRes = await runner.testConnection(host.id);
  assert.equal(testRes.ok, true);
  assert.equal(testRes.homeDir, '/home/ubuntu');
  assert.equal(runner.getStatus(host.id).status, 'connected');

  const dirRes = await runner.listDir(host.id, '/home/ubuntu/proj');
  assert.equal(dirRes.entries.length, 1);
  assert.equal(dirRes.entries[0].uri, makeRemoteUri(host.id, '/home/ubuntu/proj/train.py'));

  // Regression: unsaved password-auth host (empty id) must browse dirs with passwordOverride without touching vault
  const unsavedDirRes = await runner.listDir({ id: '', host: '10.0.0.8', port: 2222, user: 'ubuntu', authType: 'password' }, '/home/ubuntu/proj', '', { passwordOverride: 'pw123' });
  assert.equal(unsavedDirRes.entries.length, 1);

  const imgRes = await runner.readFile(host.id, '/home/ubuntu/proj/loss.png');
  assert.equal(imgRes.kind, 'image');
  assert.equal(imgRes.mimeType, 'image/png');
  assert.equal(imgRes.dataBase64, 'AAAA');

  const runRes = await runner.runCommand(host.id, { command: 'python3 train.py', cwd: '/home/ubuntu/proj', background: true });
  assert.equal(runRes.running, true);
  assert.equal(runRes.pid, 4321);

  const stRes = await runner.jobStatus(host.id, runRes.jobId);
  assert.equal(stRes.running, true);
  assert.match(stRes.output, /epoch 5/);

  const gitRes = await runner.gitStatus(host.id, '/home/ubuntu/proj');
  assert.equal(gitRes.isRepo, true);
  assert.equal(gitRes.branch, 'main');
  assert.equal(gitRes.ahead, 1);
  assert.equal(gitRes.counts.modified, 1);
  assert.equal(gitRes.counts.untracked, 1);

  const localUpload = join(tmp, 'sample.txt');
  writeFileSync(localUpload, 'hello');
  const txRes = await runner.transfer(host.id, { direction: 'upload', localPath: localUpload, remotePath: '/home/ubuntu/proj/sample.txt' });
  assert.equal(txRes.ok, true);

  rmSync(tmp, { recursive: true, force: true });
});

test('ssh-boundary hook enforces ADR-0002 isolation, preserves artifact access, and filters selected skills/plugins', () => {
  const tmp = makeTempDir('agy-ssh-boundary-');
  const fakeHome = join(tmp, 'home');
  const artifactDir = join(tmp, 'artifacts');
  mkdirSync(artifactDir, { recursive: true });

  const store = createSshProjectsStore({ dataDir: join(tmp, 'data'), home: fakeHome, vault: makeFakeVault() });
  const host = store.upsertHost({ name: 'seeta-4090', host: '10.0.0.9', user: 'root', port: 11430, authType: 'key' });
  const proj = store.createProject({
    name: 'my-gpu-proj',
    hostId: host.id,
    remoteDir: '/root/exp',
    capabilityScope: { mode: 'selected', allowedSkills: ['pytorch-training'], allowedPlugins: ['gdrive'] }
  });

  // Non-SSH workspace PreToolUse must explicitly return { decision: 'allow' } (Antigravity requires decision on PreToolUse)
  assert.deepEqual(evaluateSshBoundaryHook({ hookEventName: 'PreToolUse', cwd: tmp, toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } }, { home: fakeHome }), { decision: 'allow' });
  assert.deepEqual(evaluateSshBoundaryHook({ hookEventName: 'SessionStart', cwd: tmp }, { home: fakeHome }), {});

  // SessionStart injects SSH context and selected capability scope
  const startOut = evaluateSshBoundaryHook({ hookEventName: 'SessionStart', cwd: proj.proxyWorkspaceDir }, { home: fakeHome });
  assert.equal(startOut.injectSteps.length, 1);
  assert.match(startOut.injectSteps[0].systemMessage.systemMessage, /seeta-4090/);
  assert.match(startOut.injectSteps[0].systemMessage.systemMessage, /pytorch-training/);

  // Local run_command, edit_file, read_file on local disk, and agy-fast are denied
  const denyCmd = evaluateSshBoundaryHook({ hookEventName: 'PreToolUse', cwd: proj.proxyWorkspaceDir, artifactDirectoryPath: artifactDir, toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf outputs' } } }, { home: fakeHome });
  assert.equal(denyCmd.decision, 'deny');

  const denyRead = evaluateSshBoundaryHook({ hookEventName: 'PreToolUse', cwd: proj.proxyWorkspaceDir, artifactDirectoryPath: artifactDir, toolCall: { name: 'read_file', args: { Path: '/etc/hosts' } } }, { home: fakeHome });
  assert.equal(denyRead.decision, 'deny');

  const denyFast = evaluateSshBoundaryHook({ hookEventName: 'PreToolUse', cwd: proj.proxyWorkspaceDir, artifactDirectoryPath: artifactDir, toolCall: { name: 'mcp_agy-fast_fast_batch_search', args: {} } }, { home: fakeHome });
  assert.equal(denyFast.decision, 'deny');

  // Own SSH tools pass through cleanly without extra confirmation gate (Q12=B)
  assert.deepEqual(evaluateSshBoundaryHook({ hookEventName: 'PreToolUse', cwd: proj.proxyWorkspaceDir, toolCall: { name: 'mcp_agy-ssh-projects_ssh_run_command', args: { command: 'nvidia-smi' } } }, { home: fakeHome }), { decision: 'allow' });

  // Artifact directory read/write is allowed
  assert.deepEqual(evaluateSshBoundaryHook({ hookEventName: 'PreToolUse', cwd: proj.proxyWorkspaceDir, artifactDirectoryPath: artifactDir, toolCall: { name: 'write_file', args: { Path: join(artifactDir, 'report.md') } } }, { home: fakeHome }), { decision: 'allow' });

  // Selected skill is allowed; unselected skill is denied
  const allowedSkillPath = join(fakeHome, '.gemini', 'config', 'skills', 'pytorch-training', 'SKILL.md');
  const blockedSkillPath = join(fakeHome, '.gemini', 'config', 'skills', 'unrelated-skill', 'SKILL.md');
  assert.deepEqual(evaluateSshBoundaryHook({ hookEventName: 'PreToolUse', cwd: proj.proxyWorkspaceDir, toolCall: { name: 'read_file', args: { Path: allowedSkillPath } } }, { home: fakeHome }), { decision: 'allow' });
  assert.equal(evaluateSshBoundaryHook({ hookEventName: 'PreToolUse', cwd: proj.proxyWorkspaceDir, toolCall: { name: 'read_file', args: { Path: blockedSkillPath } } }, { home: fakeHome }).decision, 'deny');

  // Selected MCP plugin is allowed; unselected MCP plugin is denied
  assert.deepEqual(evaluateSshBoundaryHook({ hookEventName: 'PreToolUse', cwd: proj.proxyWorkspaceDir, toolCall: { name: 'call_mcp_tool', args: { ServerName: 'gdrive', ToolName: 'list' } } }, { home: fakeHome }), { decision: 'allow' });
  assert.equal(evaluateSshBoundaryHook({ hookEventName: 'PreToolUse', cwd: proj.proxyWorkspaceDir, toolCall: { name: 'call_mcp_tool', args: { ServerName: 'gmail', ToolName: 'send' } } }, { home: fakeHome }).decision, 'deny');

  rmSync(tmp, { recursive: true, force: true });
});

test('ssh-mcp-server responds to initialize and advertises all 10 ssh_* tools, and package bundle includes SSH assets', async () => {
  const repoRoot = join(import.meta.dirname, '..');
  const bundle = collectPackage(repoRoot);
  const paths = new Set(bundle.files.map(f => f.path));
  for (const requiredFile of ['mcp_config.json', 'hooks.json', 'scripts/ssh-mcp-server.mjs', 'scripts/ssh-boundary-hook.mjs', 'lib/ssh-projects.mjs', 'lib/ssh-runner.mjs', 'lib/ssh-vault.mjs', 'lib/ssh-boundary.mjs', 'lib/native-ssh-projects.js']) {
    assert.equal(paths.has(requiredFile), true, `bundle missing ${requiredFile}`);
  }

  const responses = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'ssh-mcp-server.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const out = [];
    let buf = '';
    const timer = setTimeout(() => { child.kill(); rejectPromise(new Error('MCP server timeout')); }, 8000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) out.push(JSON.parse(line));
        if (out.length >= 2) {
          clearTimeout(timer);
          child.stdin.end();
          resolvePromise(out);
        }
      }
    });
    child.on('error', err => { clearTimeout(timer); rejectPromise(err); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  });

  assert.equal(responses[0].result.serverInfo.name, 'agy-ssh-projects');
  const toolNames = responses[1].result.tools.map(t => t.name);
  assert.ok(toolNames.includes('ssh_run_command'));
  assert.ok(toolNames.includes('ssh_read_file'));
  assert.ok(toolNames.includes('ssh_transfer'));
  assert.equal(toolNames.length, 10);
});

test('native-ssh-projects injects SSH Server into Add Resource menu and swaps sidebar icon to Cloud+SSH', async () => {
  const vm = await import('node:vm');
  const repoRoot = join(import.meta.dirname, '..');
  const uiCode = readFileSync(join(repoRoot, 'lib', 'native-ssh-projects.js'), 'utf8');

  class FakeEl {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attrs = new Map();
      this.style = {};
      this.parentElement = null;
      this.className = '';
      this.textContent = '';
      this._innerHTML = '';
      this.listeners = {};
      this.isConnected = true;
    }
    set innerHTML(v) { this._innerHTML = String(v); }
    get innerHTML() { return this._innerHTML; }
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    getAttribute(k) { return this.attrs.get(k) ?? null; }
    hasAttribute(k) { return this.attrs.has(k); }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    prepend(child) { child.parentElement = this; this.children.unshift(child); return child; }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this);
      this.parentElement = null;
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    closest(sel) {
      let cur = this;
      while (cur) { if (cur.matches(sel)) return cur; cur = cur.parentElement; }
      return null;
    }
    matches(sel) {
      for (const part of sel.split(',').map(s => s.trim())) {
        const tid = part.match(/^\[data-testid="([^"]+)"\]$/);
        if (tid && this.getAttribute('data-testid') === tid[1]) return true;
        const role = part.match(/^\[role="([^"]+)"\]$/);
        if (role && this.getAttribute('role') === role[1]) return true;
        const attr = part.match(/^\[([a-z0-9-]+)\]$/i);
        if (attr && this.hasAttribute(attr[1])) return true;
        if (part.toUpperCase() === this.tagName) return true;
      }
      return false;
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = node => {
        for (const ch of node.children) {
          if (ch.matches(sel)) out.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }

  const body = new FakeEl('body');
  const head = new FakeEl('head');
  const step = new FakeEl('div');
  step.setAttribute('data-testid', 'project-folder-selection-step');
  body.appendChild(step);

  const menu = new FakeEl('div');
  menu.setAttribute('role', 'menu');
  menu.textContent = 'Upload Files Google Drive GitHub';
  const ghBtn = new FakeEl('button');
  ghBtn.textContent = 'GitHub';
  menu.appendChild(ghBtn);
  body.appendChild(menu);

  const sshHdr = new FakeEl('div');
  sshHdr.setAttribute('data-testid', 'project-header');
  const sshIcon = new FakeEl('span');
  sshIcon.setAttribute('data-testid', 'project-header-icon');
  const origSvg = new FakeEl('span');
  sshIcon.appendChild(origSvg);
  const sshActions = new FakeEl('div');
  sshActions.setAttribute('data-testid', 'project-header-actions');
  sshHdr.appendChild(sshIcon);
  sshHdr.appendChild(sshActions);
  body.appendChild(sshHdr);

  const localHdr = new FakeEl('div');
  localHdr.setAttribute('data-testid', 'project-header');
  const localIcon = new FakeEl('span');
  localIcon.setAttribute('data-testid', 'project-header-icon');
  const localOrig = new FakeEl('span');
  localIcon.appendChild(localOrig);
  localHdr.appendChild(localIcon);
  body.appendChild(localHdr);

  const sandbox = {
    React: { createElement: () => null, Fragment: Symbol('Fragment'), useState: v => [v, () => {}], useEffect: () => {}, useCallback: f => f, useRef: v => ({ current: v }) },
    ReactDOM: { createRoot: () => ({ render() {}, unmount() {} }) },
    document: {
      head,
      body,
      createElement: tag => new FakeEl(tag),
      querySelector: sel => body.querySelector(sel),
      querySelectorAll: sel => body.querySelectorAll(sel),
      dispatchEvent: () => {}
    },
    location: { search: '' },
    setInterval,
    clearInterval
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(uiCode, sandbox);

  const ui = sandbox.__agyCreateSshProjects({
    adapter: {
      projectIdFromElement: el => (el === sshHdr ? 'proj-ssh-1' : 'proj-local-1'),
      sidebarProjects: () => [{ id: 'proj-ssh-1', folderUris: ['file:///tmp/ssh-1'] }, { id: 'proj-local-1', folderUris: ['file:///tmp/local-1'] }],
      setCustomSidePanel: () => {}
    },
    request: async method => {
      if (method === 'sshProject.list') {
        return {
          ok: true,
          hosts: [{ id: 'h1', name: 'autodl-4090', host: '1.2.3.4', port: 11430, user: 'root' }],
          projects: [{ id: 'proj-ssh-1', nativeProjectId: 'proj-ssh-1', name: 'autodl-4090', hostId: 'h1', remoteDir: '/root/exp', workspaceUri: 'file:///tmp/ssh-1', host: { id: 'h1', name: 'autodl-4090' } }],
          statuses: { h1: { status: 'connected' } },
          configHosts: [],
          capabilities: { skills: [], plugins: [] }
        };
      }
      return { ok: true };
    },
    options: () => ({ enabled: true }),
    currentId: () => '',
    uiText: zh => zh
  });

  ui.sync({ enabled: true });
  await ui.refresh();
  ui.sync({ enabled: true });

  // 1. Add Resource dropdown got SSH Server button
  const sshAddItem = menu.querySelector('[data-testid="agy-ssh-add-resource-item"]');
  assert.ok(sshAddItem, 'expected SSH Server button in Add Resource menu');
  assert.match(sshAddItem.innerHTML, /SSH 服务器/);

  // 2. SSH project header got Cloud+SSH icon + settings gear, while local project stayed untouched
  assert.ok(sshIcon.querySelector('[data-agy-ssh-cloud-icon]'));
  assert.equal(origSvg.style.display, 'none');
  assert.ok(sshActions.querySelector('[data-testid="agy-ssh-project-settings-btn"]'));
  assert.equal(localIcon.querySelector('[data-agy-ssh-cloud-icon]'), null);
  assert.equal(localOrig.style.display, undefined);

  ui.dispose();
  assert.equal(sshIcon.querySelector('[data-agy-ssh-cloud-icon]'), null);
  assert.equal(origSvg.style.display, '');
});
