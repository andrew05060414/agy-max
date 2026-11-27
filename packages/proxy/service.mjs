import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function registerModule(bus, ctx) {
  const importCoreLib = name => import(pathToFileURL(join(ctx.pluginRoot, 'lib', name)).href);
  const [{ checkProxyPortOpen, inspectProxyRuntime, probeProxyConnectivity }, { isRemoteSshEnvironment }] = await Promise.all([
    importCoreLib('proxy.mjs'),
    importCoreLib('launcher.mjs')
  ]);

  bus.registerRpc('proxy', 'proxy.status', () => ({
    ...inspectProxyRuntime(ctx.settings.get(), process.env),
    canRelaunch: !isRemoteSshEnvironment(),
    relaunching: ctx.isRelaunchPending()
  }));

  bus.registerRpc('proxy', 'proxy.test', async request => {
    const targetUrl = typeof request.proxyUrl === 'string' ? request.proxyUrl : ctx.settings.get().proxyUrl;
    const probed = await probeProxyConnectivity(targetUrl);
    return {
      ok: probed.ok,
      reachable: probed.reachable,
      tunnelOk: probed.tunnelOk,
      latencyMs: probed.latencyMs,
      statusCode: probed.statusCode,
      url: probed.url,
      message: probed.error || ''
    };
  });

  bus.registerRpc('proxy', 'proxy.relaunch', async request => {
    if (isRemoteSshEnvironment()) throw new Error('SSH 远端模式不支持重启本地客户端');
    const current = ctx.settings.get();
    if (current.proxyEnabled && current.proxyUrl && request.force !== true) {
      const portCheck = await checkProxyPortOpen(current.proxyUrl, 900);
      if (!portCheck.ok) {
        return { ok: false, portUnreachable: true, message: portCheck.error, host: portCheck.host, port: portCheck.port };
      }
    }
    const launched = ctx.triggerRelaunch();
    return { ok: true, relaunching: Boolean(launched.scheduled), proxyActive: Boolean(launched.proxyActive) };
  });
}
