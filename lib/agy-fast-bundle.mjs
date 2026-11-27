import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, lstatSync, rmSync, cpSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isSameHome, resolveAntigravityExecutable, windowsCmdInvocation } from './launcher.mjs';

export const AGY_FAST_ID = 'agy-fast';
export const MANAGED_MARKER = '.agy-max-managed.json';
export const PARKED_MARKER = '.agy-max-parked.json';
export const MANAGED_STATE_FILE = 'agy-fast-managed.json';
const MAX_LOCAL_RULE_BYTES = 256 * 1024;
const LOCAL_RULE_NAME_RE = /^[^\\/:*?"<>|]+\.local\.md$/;

// Bundled agy-fast is updated with agy-max; its own updater must stay off.
function disableBundledAgyFastUpdater(home) {
  const cacheDir = assertSafeOwned(home, join(home, '.gemini', 'cache', 'agy-fast'));
  const configPath = join(cacheDir, 'config.json');
  let cfg = {};
  if (existsSync(configPath)) {
    // Leave a config we can't read alone rather than failing the enable.
    try { cfg = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')); } catch { return; }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return;
  }
  if (cfg.autoUpdate === 'off') return;
  writeAtomicJson(configPath, { ...cfg, autoUpdate: 'off' });
}

function assertSafeOwned(root, target) {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('目标路径越界');
  let cur = resolve(root);
  if (lstatSync(cur, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('目标目录不能是符号链接');
  for (const part of rel.split(/[\\/]/)) {
    cur = join(cur, part);
    if (lstatSync(cur, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('目标路径包含符号链接');
  }
  return resolve(target);
}

export function removePathSafe(target) {
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return;
  if (process.platform === 'win32' && stat.isSymbolicLink()) {
    try { rmdirSync(target); } catch (error) {
      if (error.code === 'ENOENT') return;
      if (error.code !== 'ENOTDIR' && error.code !== 'EINVAL') throw error;
      try { unlinkSync(target); } catch (unlinkErr) { if (unlinkErr.code !== 'ENOENT') throw unlinkErr; }
    }
    return;
  }
  rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

function assertCleanTree(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error('清理目录中包含符号链接');
  if (stat.isDirectory()) for (const name of readdirSync(path)) assertCleanTree(join(path, name));
}

function writeAtomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.agy-max-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch {}
  }
}

function readConfigPluginEntry(root, configPath) {
  assertSafeOwned(root, configPath);
  if (!existsSync(configPath)) return undefined;
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return undefined;
    return cfg.plugins?.[AGY_FAST_ID];
  } catch {
    return undefined;
  }
}

function isDanglingDisabledConfigEntry(root, configPath) {
  const entry = readConfigPluginEntry(root, configPath);
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  return entry.enabled === false && Object.keys(entry).every(k => k === 'enabled');
}

function updateConfigPluginState(root, configPath, state, changeConfig) {
  assertSafeOwned(root, configPath);
  const mutate = cfg => {
    if (state === undefined) delete cfg.plugins?.[AGY_FAST_ID];
    else {
      cfg.plugins ||= {};
      cfg.plugins[AGY_FAST_ID] = { ...cfg.plugins[AGY_FAST_ID], enabled: Boolean(state) };
    }
  };
  if (changeConfig) return changeConfig(configPath, mutate);
  const cfg = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')) : {};
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return;
  const before = JSON.stringify(cfg);
  mutate(cfg);
  if (before !== JSON.stringify(cfg)) writeAtomicJson(configPath, cfg);
}

function readLocalRulesFromDir(dir) {
  const dirStat = lstatSync(dir, { throwIfNoEntry: false });
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return [];
  const saved = [];
  for (const name of readdirSync(dir)) {
    if (!LOCAL_RULE_NAME_RE.test(name)) continue;
    const p = join(dir, name);
    try {
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (st && st.isFile() && !st.isSymbolicLink() && st.size <= MAX_LOCAL_RULE_BYTES) {
        saved.push({ name, bytes: readFileSync(p) });
      }
    } catch {}
  }
  return saved;
}

function snapshotLocalRules(pluginDir) {
  return readLocalRulesFromDir(join(pluginDir, 'rules'));
}

function restoreLocalRules(pluginDir, entries) {
  if (!entries?.length) return;
  const rulesDir = join(pluginDir, 'rules');
  mkdirSync(rulesDir, { recursive: true });
  for (const { name, bytes } of entries) {
    if (LOCAL_RULE_NAME_RE.test(name)) {
      writeFileSync(join(rulesDir, name), bytes, { mode: 0o644 });
    }
  }
}

const renameWaitBuf = new Int32Array(new SharedArrayBuffer(4));
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
      Atomics.wait(renameWaitBuf, 0, 0, 40 * (attempt + 1));
    }
  }
}

function stagePlugin(sourceDir, targetDir, prepare, { replace = false, stagingParent = dirname(targetDir) } = {}) {
  assertCleanTree(sourceDir);
  mkdirSync(dirname(targetDir), { recursive: true });
  mkdirSync(stagingParent, { recursive: true });
  const stage = mkdtempSync(join(stagingParent, '.agy-fast-stage-'));
  const previous = `${stage}-previous`;
  let promoted = false;
  try {
    cpSync(sourceDir, stage, { recursive: true, force: true });
    prepare(stage);
    if (replace) renameWithRetry(targetDir, previous);
    else if (lstatSync(targetDir, { throwIfNoEntry: false })) throw new Error('agy-fast 目标目录已存在');
    try { renameWithRetry(stage, targetDir); } catch (error) {
      if (replace) try { renameWithRetry(previous, targetDir); } catch {}
      throw error;
    }
    promoted = true;
  } finally {
    if (promoted) removePathSafe(previous);
    else removePathSafe(stage);
  }
}

function tryAgyCliToggle(home, enable, { runCli, platform = process.platform, env = process.env } = {}) {
  if (typeof runCli === 'function') return Boolean(runCli(enable));
  if (runCli === false) return false;
  if (runCli !== true && !isSameHome(home, homedir(), platform)) return false;
  const sub = enable ? 'enable' : 'disable';
  const hostExe = platform === 'win32' ? resolveAntigravityExecutable({ home, platform, env }) : '';
  const candidates = platform === 'win32'
    ? [...(hostExe ? [join(dirname(hostExe), 'resources', 'app', 'bin', 'agy.cmd'), join(dirname(hostExe), 'resources', 'bin', 'agy.cmd')].filter(existsSync) : []), 'agy.cmd', 'agy.exe']
    : ['agy', join(home, '.local', 'bin', 'agy'), '/Applications/Antigravity.app/Contents/Resources/app/bin/agy', '/opt/homebrew/bin/agy', '/usr/local/bin/agy'];
  for (const bin of candidates) {
    try {
      const cliArgs = ['plugin', sub, AGY_FAST_ID];
      const invocation = platform === 'win32' && /\.cmd$/i.test(bin) ? windowsCmdInvocation(bin, cliArgs, env) : { command: bin, args: cliArgs };
      const res = spawnSync(invocation.command, invocation.args, {
        stdio: 'ignore',
        timeout: 6000,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        env: { ...env, HOME: home, USERPROFILE: home }
      });
      if (!res.error && res.status === 0) return true;
    } catch {}
  }
  return false;
}

export function syncBundledAgyFast({ home = homedir(), enabled = true, vendorDir, runCli, changeConfig } = {}) {
  const resolvedHome = resolve(home);
  const root = join(resolvedHome, '.gemini');
  const configPath = join(root, 'config', 'config.json');
  const pluginsDir = join(root, 'config', 'plugins');
  const targetDir = join(pluginsDir, AGY_FAST_ID);
  const dataDir = join(root, 'antigravity', 'plugin_data', 'agy-max');
  const parkedDir = join(dataDir, 'parked-plugins', AGY_FAST_ID);
  const localRulesBackupDir = join(dataDir, 'agy-fast-local-rules');
  const managedStateFile = join(dataDir, MANAGED_STATE_FILE);
  const sourceDir = vendorDir ? resolve(vendorDir) : fileURLToPath(new URL('./vendor/agy-fast', import.meta.url));

  assertSafeOwned(resolvedHome, pluginsDir);
  assertSafeOwned(resolvedHome, dataDir);

  if (existsSync(targetDir) && lstatSync(targetDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
    updateConfigPluginState(root, configPath, enabled, changeConfig);
    tryAgyCliToggle(resolvedHome, enabled, { runCli });
    return { ok: true, enabled: Boolean(enabled), mode: 'symlink' };
  }

  assertSafeOwned(resolvedHome, targetDir);
  assertSafeOwned(resolvedHome, parkedDir);
  assertSafeOwned(resolvedHome, localRulesBackupDir);
  assertSafeOwned(resolvedHome, managedStateFile);

  if (existsSync(targetDir)) {
    const manifestPath = join(targetDir, 'plugin.json');
    if (existsSync(manifestPath)) {
      const name = JSON.parse(readFileSync(manifestPath, 'utf8'))?.name;
      if (name && name !== AGY_FAST_ID) throw new Error('agy-fast 目录被其他插件占用');
    }
  }

  if (enabled) {
    const stagingParent = assertSafeOwned(resolvedHome, join(dataDir, 'staging'));
    const parkedStat = lstatSync(parkedDir, { throwIfNoEntry: false });
    if (!existsSync(targetDir) && parkedStat && !parkedStat.isSymbolicLink()) {
      stagePlugin(parkedDir, targetDir, stage => removePathSafe(join(stage, PARKED_MARKER)), { stagingParent });
      removePathSafe(parkedDir);
      try { unlinkSync(managedStateFile); } catch {}
    } else if (!existsSync(targetDir) || existsSync(join(targetDir, MANAGED_MARKER))) {
      const replace = existsSync(targetDir);
      if (!existsSync(join(sourceDir, 'plugin.json'))) return { ok: false, enabled: true, reason: 'missing-vendor' };
      if (replace) assertCleanTree(targetDir);
      const vendorVer = JSON.parse(readFileSync(join(sourceDir, 'plugin.json'), 'utf8')).version || '0.3.2';
      const marker = { managedBy: 'agy-max', version: vendorVer };
      const localRules = replace ? snapshotLocalRules(targetDir) : readLocalRulesFromDir(localRulesBackupDir);
      stagePlugin(sourceDir, targetDir, stage => {
        restoreLocalRules(stage, localRules);
        writeAtomicJson(join(stage, MANAGED_MARKER), marker);
      }, { replace, stagingParent });
      if (!replace) removePathSafe(localRulesBackupDir);
      writeAtomicJson(managedStateFile, marker);
    } else {
      try { unlinkSync(managedStateFile); } catch {}
    }
    // A user's own agy-fast install keeps its own update setting.
    if (existsSync(join(targetDir, MANAGED_MARKER))) disableBundledAgyFastUpdater(resolvedHome);
    updateConfigPluginState(root, configPath, true, changeConfig);
    tryAgyCliToggle(resolvedHome, true, { runCli });
    return { ok: true, enabled: true, installed: existsSync(targetDir) };
  }

  const previousEntry = readConfigPluginEntry(root, configPath);
  const previousEnabled = previousEntry?.enabled !== false;

  if (existsSync(targetDir)) {
    assertCleanTree(targetDir);
    const managed = existsSync(join(targetDir, MANAGED_MARKER));
    if (managed) {
      const localRules = snapshotLocalRules(targetDir);
      const backupStat = lstatSync(localRulesBackupDir, { throwIfNoEntry: false });
      if (backupStat) {
        assertCleanTree(localRulesBackupDir);
        removePathSafe(localRulesBackupDir);
      }
      if (localRules.length) {
        mkdirSync(localRulesBackupDir, { recursive: true });
        for (const { name, bytes } of localRules) writeFileSync(join(localRulesBackupDir, name), bytes, { mode: 0o644 });
      }
      writeAtomicJson(managedStateFile, { managedBy: 'agy-max', disabled: true });
      removePathSafe(targetDir);
    } else {
      if (lstatSync(parkedDir, { throwIfNoEntry: false })) {
        return { ok: false, enabled: previousEnabled, installed: true, reason: 'parked-exists', retained: [parkedDir] };
      }
      stagePlugin(targetDir, parkedDir, stage => writeAtomicJson(join(stage, PARKED_MARKER), { userOwned: true, previousEnabled }));
      try { unlinkSync(managedStateFile); } catch {}
      removePathSafe(targetDir);
    }
  } else if (!lstatSync(parkedDir, { throwIfNoEntry: false })) {
    writeAtomicJson(managedStateFile, { managedBy: 'agy-max', disabled: true });
  }

  updateConfigPluginState(root, configPath, false, changeConfig);
  tryAgyCliToggle(resolvedHome, false, { runCli });
  return { ok: true, enabled: false, installed: false };
}

export function cleanupBundledAgyFast({ home = homedir(), runCli, changeConfig } = {}) {
  const resolvedHome = resolve(home);
  const root = join(resolvedHome, '.gemini');
  const configPath = join(root, 'config', 'config.json');
  const pluginsDir = join(root, 'config', 'plugins');
  const targetDir = join(pluginsDir, AGY_FAST_ID);
  const dataDir = join(root, 'antigravity', 'plugin_data', 'agy-max');
  const parkedDir = join(dataDir, 'parked-plugins', AGY_FAST_ID);
  const localRulesBackupDir = join(dataDir, 'agy-fast-local-rules');
  const managedStateFile = join(dataDir, MANAGED_STATE_FILE);

  const parkedStat = lstatSync(parkedDir, { throwIfNoEntry: false });
  if (parkedStat) {
    if (parkedStat.isSymbolicLink()) {
      return { ok: false, restored: false, retained: [parkedDir] };
    }
    try {
      assertSafeOwned(resolvedHome, pluginsDir);
      assertSafeOwned(resolvedHome, parkedDir);
      const markerPath = join(parkedDir, PARKED_MARKER);
      const markerStat = lstatSync(markerPath, { throwIfNoEntry: false });
      const parkedMeta = markerStat && markerStat.isFile() && !markerStat.isSymbolicLink()
        ? JSON.parse(readFileSync(markerPath, 'utf8'))
        : null;
      if (parkedMeta?.userOwned) {
        assertSafeOwned(resolvedHome, targetDir);
        if (lstatSync(targetDir, { throwIfNoEntry: false })) {
          return { ok: false, restored: false, retained: [parkedDir] };
        }
        const stagingParent = assertSafeOwned(resolvedHome, join(dataDir, 'staging'));
        stagePlugin(parkedDir, targetDir, stage => removePathSafe(join(stage, PARKED_MARKER)), { stagingParent });
        const shouldEnable = parkedMeta.previousEnabled !== false;
        updateConfigPluginState(root, configPath, shouldEnable, changeConfig);
        if (shouldEnable) tryAgyCliToggle(resolvedHome, true, { runCli });
        try {
          removePathSafe(parkedDir);
        } catch {
          return { ok: false, restored: true, retained: [parkedDir] };
        }
        try { unlinkSync(managedStateFile); } catch {}
        return { ok: true, restored: true, retained: [] };
      }
      if (markerStat && !(parkedMeta && parkedMeta.userOwned === false)) {
        return { ok: false, restored: false, retained: [parkedDir] };
      }
      assertCleanTree(parkedDir);
      removePathSafe(parkedDir);
      return { ok: true, restored: false, retained: [] };
    } catch {
      return { ok: false, restored: false, retained: [parkedDir] };
    }
  }

  try {
    assertSafeOwned(resolvedHome, pluginsDir);
    const targetStat = lstatSync(targetDir, { throwIfNoEntry: false });
    if (targetStat && !targetStat.isSymbolicLink() && existsSync(join(targetDir, MANAGED_MARKER))) {
      assertSafeOwned(resolvedHome, targetDir);
      assertCleanTree(targetDir);
      updateConfigPluginState(root, configPath, false, changeConfig);
      tryAgyCliToggle(resolvedHome, false, { runCli });
      removePathSafe(targetDir);
      updateConfigPluginState(root, configPath, undefined, changeConfig);
      try { unlinkSync(managedStateFile); } catch {}
      const backupStat = lstatSync(localRulesBackupDir, { throwIfNoEntry: false });
      if (backupStat && !backupStat.isSymbolicLink()) {
        try { assertSafeOwned(resolvedHome, localRulesBackupDir); assertCleanTree(localRulesBackupDir); removePathSafe(localRulesBackupDir); } catch {}
      }
      return { ok: true, restored: false, retained: [] };
    }
    if (!targetStat) {
      const hasManagedMarker = Boolean(lstatSync(managedStateFile, { throwIfNoEntry: false }));
      const hasRulesBackup = Boolean(lstatSync(localRulesBackupDir, { throwIfNoEntry: false }));
      if (hasManagedMarker || hasRulesBackup || isDanglingDisabledConfigEntry(root, configPath)) {
        updateConfigPluginState(root, configPath, undefined, changeConfig);
      }
      try { unlinkSync(managedStateFile); } catch {}
    }
    return { ok: true, restored: false, retained: [] };
  } catch {
    return { ok: false, restored: false, retained: [] };
  }
}
