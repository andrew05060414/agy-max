import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function registerModule(bus, ctx) {
  const importCoreLib = name => import(pathToFileURL(join(ctx.pluginRoot, 'lib', name)).href);
  const { createThoughtTranslator } = await importCoreLib('thought-translator.mjs');

  const mpTranslator = ctx.marketplaceTranslator ?? createThoughtTranslator(ctx.dataDir, {
    cacheFile: 'marketplace-i18n-cache.json',
    maxCacheEntries: 4000,
    timeoutMs: 12000,
    getSettings: () => ctx.settings.get()
  });

  bus.registerRpc('i18n', 'marketplace.translate', async request => {
    const cur = ctx.settings.get();
    if (!cur.marketplaceTranslate) return { ok: true, translations: {} };
    return mpTranslator.translateBatch({
      texts: Array.isArray(request.texts) ? request.texts : [],
      mode: 'machine',
      targetLang: 'zh-CN'
    });
  });
}
