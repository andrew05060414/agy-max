import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_MODULE_IDS } from '../packages/core/catalog.mjs';
import { collectModuleBundle, encodeModuleBundle, moduleSeedName, sha256Hex } from '../packages/core/module-bundle.mjs';

export function buildAllModuleSeeds(rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  const seedsDir = join(rootDir, 'vendor', 'seeds');
  mkdirSync(seedsDir, { recursive: true });
  const manifest = [];
  for (const id of ALL_MODULE_IDS) {
    const modDir = join(rootDir, 'packages', id);
    const bundle = collectModuleBundle(modDir, pkg.version, { repoRoot: rootDir });
    const gz = encodeModuleBundle(bundle);
    const fileName = moduleSeedName(id);
    writeFileSync(join(seedsDir, fileName), gz);
    manifest.push({ id, version: pkg.version, file: fileName, bytes: gz.length, sha256: sha256Hex(gz) });
  }
  return manifest;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const built = buildAllModuleSeeds();
  console.log(JSON.stringify({ count: built.length, seeds: built }));
}
