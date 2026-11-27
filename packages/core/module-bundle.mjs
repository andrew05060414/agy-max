import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { isKnownModuleId } from './catalog.mjs';

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_MODULE_BUNDLE_BYTES = 12 * 1024 * 1024;

export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
export const moduleReleaseName = (id, version) => `agy-module-${id}-v${version}.bundle.gz`;
export const moduleSeedName = id => `agy-module-${id}.bundle.gz`;

export function safeModuleRelPath(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length < 200
    && !name.includes('\\')
    && !name.includes(':')
    && name.split('/').every(part =>
      part
      && part !== '.'
      && part !== '..'
      && !/[ .]$/.test(part)
      && !/[\x00-\x1f<>"|?*]/.test(part)
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    );
}

export function collectModuleBundle(moduleDir, versionOverride = '', { repoRoot = resolve(moduleDir, '..', '..') } = {}) {
  const dir = resolve(moduleDir);
  const manifestPath = join(dir, 'module.json');
  if (!existsSync(manifestPath)) throw new Error(`Missing module.json in ${dir}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const id = manifest?.id;
  if (!isKnownModuleId(id)) throw new Error(`Unknown module id: ${id}`);
  const version = versionOverride || manifest.version;
  if (!VERSION_RE.test(version || '')) throw new Error(`Invalid module version for ${id}: ${version}`);

  const files = [];
  const seenRel = new Set();
  function addBytes(rel, bytes) {
    if (seenRel.has(rel.toLowerCase())) return;
    if (!safeModuleRelPath(rel)) throw new Error(`Unsafe module file path: ${rel}`);
    seenRel.add(rel.toLowerCase());
    files.push({ path: rel, sha256: sha256Hex(bytes), size: bytes.length, data: bytes.toString('base64') });
  }
  function visit(curPath) {
    const st = lstatSync(curPath);
    if (st.isSymbolicLink()) throw new Error(`Module ${id} cannot contain symlinks`);
    if (st.isDirectory()) {
      for (const entry of readdirSync(curPath).sort()) visit(join(curPath, entry));
      return;
    }
    if (!st.isFile()) return;
    const rel = relative(dir, curPath).replaceAll('\\', '/');
    if (rel.endsWith('.test.mjs') || rel === '.agy-module-receipt.json') return;
    let bytes = readFileSync(curPath);
    if (rel === 'module.json' && versionOverride && manifest.version !== versionOverride) {
      bytes = Buffer.from(JSON.stringify({ ...manifest, version: versionOverride }, null, 2) + '\n', 'utf8');
    }
    addBytes(rel, bytes);
  }
  visit(dir);

  const declaredExtras = [
    ...(Array.isArray(manifest.clientHelpers) ? manifest.clientHelpers : []),
    ...(Array.isArray(manifest.inlineModuleScripts) ? manifest.inlineModuleScripts : []),
    ...(Array.isArray(manifest.clientScripts) ? manifest.clientScripts : [])
  ];
  for (const extra of declaredExtras) {
    if (seenRel.has(String(extra).toLowerCase())) continue;
    const fallbackPath = join(resolve(repoRoot), 'lib', extra);
    if (existsSync(fallbackPath) && lstatSync(fallbackPath).isFile() && !lstatSync(fallbackPath).isSymbolicLink()) {
      addBytes(extra, readFileSync(fallbackPath));
    }
  }

  return validateModuleBundle({
    format: 1,
    kind: 'agy-max-module',
    id,
    version,
    files: files.sort((a, b) => a.path.localeCompare(b.path))
  });
}

export function validateModuleBundle(bundle, { expectedId = '', expectedVersion = '' } = {}) {
  if (
    bundle?.format !== 1
    || bundle.kind !== 'agy-max-module'
    || !isKnownModuleId(bundle.id)
    || !VERSION_RE.test(bundle.version || '')
    || (expectedId && bundle.id !== expectedId)
    || (expectedVersion && bundle.version !== expectedVersion)
    || !Array.isArray(bundle.files)
    || bundle.files.length === 0
    || bundle.files.length > 200
  ) {
    throw new Error('模块安装包格式或版本无效');
  }
  const seen = new Set();
  let totalBytes = 0;
  for (const file of bundle.files) {
    if (
      !safeModuleRelPath(file.path)
      || seen.has(file.path.toLowerCase())
      || !/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data || '')
    ) {
      throw new Error(`模块文件包含无效路径: ${file?.path || ''}`);
    }
    seen.add(file.path.toLowerCase());
    const bytes = Buffer.from(file.data, 'base64');
    totalBytes += bytes.length;
    if (totalBytes > MAX_MODULE_BUNDLE_BYTES || sha256Hex(bytes) !== file.sha256) {
      throw new Error(`模块文件校验失败: ${file.path}`);
    }
  }
  if (!seen.has('module.json')) throw new Error('模块安装包缺少 module.json');
  const parsedManifest = JSON.parse(Buffer.from(bundle.files.find(f => f.path === 'module.json').data, 'base64').toString('utf8'));
  if (parsedManifest.id !== bundle.id) throw new Error('模块标识不一致');
  return bundle;
}

export function encodeModuleBundle(bundle) {
  return gzipSync(Buffer.from(JSON.stringify(validateModuleBundle(bundle)), 'utf8'), { level: 9 });
}

export function decodeModuleBundle(bytes, options = {}) {
  const raw = gunzipSync(bytes, { maxOutputLength: MAX_MODULE_BUNDLE_BYTES * 2 }).toString('utf8');
  return validateModuleBundle(JSON.parse(raw), options);
}

export function writeModuleBundle(bundle, destination) {
  validateModuleBundle(bundle);
  const root = resolve(destination);
  mkdirSync(root, { recursive: true });
  let totalBytes = 0;
  for (const file of bundle.files) {
    const outPath = resolve(root, ...file.path.split('/'));
    const rel = relative(root, outPath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('模块写入路径越界');
    const bytes = Buffer.from(file.data, 'base64');
    totalBytes += bytes.length;
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, bytes, { mode: 0o644 });
  }
  const receipt = {
    id: bundle.id,
    version: bundle.version,
    totalBytes,
    installedAt: Date.now(),
    files: bundle.files.map(({ path, sha256, size }) => ({ path, sha256, size: size ?? Buffer.from(file?.data || '', 'base64').length }))
  };
  writeFileSync(join(root, '.agy-module-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  return receipt;
}
