import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function registerModule(bus, ctx) {
  const importCoreLib = name => import(pathToFileURL(join(ctx.pluginRoot, 'lib', name)).href);
  const [
    { usageDashboard },
    { createPricingStore, estimateCost },
    { createQuotaTracker },
    { estimateRequestsCost, summarizeSubagentSession }
  ] = await Promise.all([
    importCoreLib('analytics.mjs'),
    importCoreLib('pricing.mjs'),
    importCoreLib('quota.mjs'),
    importCoreLib('subagents.mjs')
  ]);

  const pricing = createPricingStore(ctx.dataDir);
  const quota = createQuotaTracker(ctx.dataDir);
  const knownAccountCount = () => bus.runSync('accounts.knownCount', 0);

  bus.on('quota.recordAccount', 'telemetry', (_val, { email, atMs, count }) => {
    if (email) {
      quota.recordAccount(email, atMs || Date.now(), { knownAccountCount: count || knownAccountCount() });
    }
    return true;
  });

  bus.registerRpc('telemetry', 'state', async (request, rpcCtx) => {
    const sshHost = await rpcCtx.resolveHost();
    const parsed = sshHost
      ? await ctx.remote.state(sshHost, { conversationId: request.conversationId, execution: request.execution })
      : ctx.parseSessionData(request.conversationId, { includeSessions: false, strict: true, execution: request.execution });
    const curSettings = ctx.settings.get();
    const enriched = await bus.runAsync('state.enrich', { goal: null }, {
      parsed,
      conversationId: request.conversationId,
      execution: request.execution,
      curSettings
    });
    return {
      ...parsed,
      goal: enriched?.goal ?? null,
      costUsd: estimateRequestsCost(parsed.requests, pricing.get().rates),
      settings: curSettings
    };
  });

  bus.registerRpc('telemetry', 'subagents.stats', async (request, rpcCtx) => {
    const ids = Array.isArray(request.conversationIds)
      ? [...new Set(request.conversationIds.filter(id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)))].slice(0, 32)
      : [];
    const rates = pricing.get().rates;
    const items = {};
    const sshHost = await rpcCtx.resolveHost();
    const remoteSessions = sshHost && ids.length ? (await ctx.remote.subagents(sshHost, { conversationIds: ids }))?.sessions || {} : null;
    for (const id of ids) {
      try {
        const parsed = remoteSessions ? remoteSessions[id] : ctx.parseSessionData(id, { includeSessions: false, strict: true });
        const summary = summarizeSubagentSession(parsed, rates);
        if (summary && (summary.telemetry?.stepCount > 0 || summary.telemetry?.requestCount > 0 || summary.contextWindow?.usedTokens > 0)) {
          items[id] = summary;
        }
      } catch { /* Skip unreadable or uninitialized subagent. */ }
    }
    return { items };
  });

  bus.registerRpc('telemetry', 'dashboard', async (request, rpcCtx) => {
    const sshHost = await rpcCtx.resolveHost();
    const activeEmail = typeof request.accountKey === 'string' ? request.accountKey.trim().toLowerCase() : '';
    if (!sshHost && activeEmail) {
      quota.recordAccount(activeEmail, Date.now(), { knownAccountCount: knownAccountCount() });
    }
    const data = sshHost
      ? await ctx.remote.dashboard(sshHost, { force: request.force === true })
      : usageDashboard(ctx.appDir, { force: request.force === true });
    const prices = pricing.get();
    const annotate = item => (!sshHost ? { ...item, accountEmail: quota.emailAt(item.timestampMs) } : item);
    return {
      ...data,
      pricing: prices,
      quotaSamples: quota.samples(activeEmail),
      accountEmails: sshHost ? [] : quota.accounts(),
      activeAccountEmail: activeEmail,
      requests: data.requests.map(r => ({ ...annotate(r), costUsd: estimateCost(r, prices.rates) })),
      errors: (data.errors || []).map(annotate)
    };
  });

  bus.registerRpc('telemetry', 'pricing.refresh', () => pricing.refresh());

  bus.registerRpc('telemetry', 'quota.observe', request =>
    quota.observe(
      request.groups,
      usageDashboard(ctx.appDir, { force: true }).requests,
      pricing.get().rates,
      Date.now(),
      request.accountKey,
      { knownAccountCount: knownAccountCount() }
    )
  );
}
