import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function registerModule(bus, ctx) {
  const importCoreLib = name => import(pathToFileURL(join(ctx.pluginRoot, 'lib', name)).href);
  const { createAccountsStore } = await importCoreLib('accounts.mjs');

  const accounts = createAccountsStore(ctx.dataDir, {
    home: ctx.home,
    relaunch: options => ctx.triggerRelaunch(options)
  });

  const knownCount = () => {
    try { return accounts.list()?.accounts?.length || 0; } catch { return 0; }
  };

  bus.on('accounts.knownCount', 'accounts', () => knownCount());

  bus.registerRpc('accounts', 'accounts.', request => {
    if (!ctx.settings.get().multiAccount) throw new Error('多账号切换未启用');
    const recordQuotaEmail = (email, count) => {
      if (email) bus.runSync('quota.recordAccount', null, { email, atMs: Date.now(), count: count || knownCount() });
    };
    if (request.method === 'accounts.list') return accounts.list();
    if (request.method === 'accounts.syncActive') {
      const reply = accounts.syncActive(request.snapshot);
      if (request.snapshot?.email && !reply?.credentialMismatch) {
        recordQuotaEmail(request.snapshot.email, reply?.accounts?.length);
      }
      return reply;
    }
    if (request.method === 'accounts.prepareAdd') return accounts.prepareAdd({ pendingAlias: request.pendingAlias });
    if (request.method === 'accounts.completeAdd') {
      const reply = accounts.completeAdd({
        email: request.email,
        prevEmail: request.prevEmail,
        prevCredHash: request.prevCredHash,
        triggerRelaunch: request.relaunch !== false
      });
      if (reply?.account?.email && !reply?.credentialMismatch && (reply.accountChanged || reply.relaunching || reply.manualRestartRequired)) {
        recordQuotaEmail(reply.account.email, reply?.accounts?.length);
      }
      return reply;
    }
    if (request.method === 'accounts.switch') {
      const reply = accounts.switchAccount(request.accountId, { auto: request.auto === true, triggerRelaunch: request.relaunch !== false });
      if (reply?.account?.email) recordQuotaEmail(reply.account.email, reply?.accounts?.length);
      return reply;
    }
    if (request.method === 'accounts.rename') return accounts.renameAccount(request.accountId, request.alias);
    if (request.method === 'accounts.setDisabled') return accounts.setDisabled(request.accountId, request.disabled);
    if (request.method === 'accounts.reorder') return accounts.reorderAccounts(request.orderedIds);
    if (request.method === 'accounts.refreshCredentials') return accounts.refreshCredentials({ accountId: request.accountId || '' });
    if (request.method === 'accounts.refreshLocalQuotas') return accounts.refreshLocalQuotas({ accountId: request.accountId || '' });
    if (request.method === 'accounts.remove') return accounts.removeAccount(request.accountId);
    if (request.method === 'accounts.autoSwitchCandidate') return accounts.pickAutoSwitch(request.depletedGroupKey);
    throw new Error('不支持的操作');
  });
}
