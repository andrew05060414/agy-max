import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devToolsPortFile } from './paths.mjs';
import { createNativeDeclarationCache } from './native-cache.mjs';
import { checkForUpdates, projectInfo } from './updates.mjs';
import { startUpdate, updateStatus } from './update-manager.mjs';
export { declaredNativeNames } from './native-cache.mjs';
import { formatConversationMarkdown } from './session-parser.mjs';
import { createSettingsStore, DEFAULT_SETTINGS, SCENE_PRESETS } from './settings.mjs';
import { createPrismService } from './prism-service.mjs';
import { createThoughtTranslator } from './thought-translator.mjs';
import { syncBundledAgyFast } from './agy-fast-bundle.mjs';
import { usageDashboard } from './analytics.mjs';
import { createPricingStore, estimateCost } from './pricing.mjs';
import { createQuotaTracker } from './quota.mjs';
import { createAccountsStore } from './accounts.mjs';
import { installationPaths } from './lifecycle.mjs';
import { checkProxyPortOpen, inspectProxyRuntime, probeProxyConnectivity } from './proxy.mjs';
import { estimateRequestsCost, summarizeSubagentSession } from './subagents.mjs';
import { copyLocalFile, isRemoteSshEnvironment, openInExternalEditor, openLocalFile, readLocalFileForAttach, resolveVerifiedLocalFilePath, scheduleRelaunchWithDebugPort } from './launcher.mjs';
import { readDatabase } from './database.mjs';
import { createGoalsStore, resolveConversationGoal, syncConversationGoal } from './goals.mjs';
import { createPriorityStore } from './priority.mjs';
import { readGitFileDiff, readGitStatus } from './git-status.mjs';
import { createWorkspaceExplorer } from './workspace-explorer.mjs';
import { createRemoteTelemetryBridge, parseSshWindowTitle, resolveRemotePosixPath } from './ssh-remote.mjs';
import { searchTranscripts } from './transcript-search.mjs';
import { createWslCdpBridge, isWslEnvironment } from './wsl.mjs';
import { saveHostToSshConfig } from './ssh-config.mjs';
import { loopbackHttpRequest } from './runtime-control.mjs';

const nativeFetch = globalThis.fetch;
const isLoopbackHost = host => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host || '').toLowerCase());
export function ensureLoopbackNoProxyEnv(env = process.env) {
  const entries = String(env.no_proxy || env.NO_PROXY || '').split(',').map(value => value.trim()).filter(Boolean);
  for (const host of ['localhost', '127.0.0.1', '::1', '[::1]']) {
    if (!entries.some(entry => entry.toLowerCase() === host)) entries.push(host);
  }
  env.NO_PROXY = env.no_proxy = entries.join(',');
}
ensureLoopbackNoProxyEnv();

// Node's global dispatcher can capture the proxy configuration before this module runs.
// Give Undici a direct HTTP upgrade while leaving WebSocket validation and framing to it.
const loopbackWebSocketDispatcher = {
  dispatch({ origin, path, method, headers, upgrade }, handler) {
    const url = new URL(origin);
    let upgradedSocket;
    const req = httpRequest({
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port,
      path,
      method,
      headers: { ...headers, connection: 'Upgrade', upgrade },
      agent: false
    });
    req.on('error', error => handler.onError(error));
    req.on('response', res => {
      res.destroy();
      handler.onError(new Error(`WebSocket upgrade returned HTTP ${res.statusCode}`));
    });
    req.on('upgrade', (res, socket, head) => {
      upgradedSocket = socket;
      // Preserve frames that arrived in the same packet as the response headers.
      if (head.length) socket.unshift(head);
      handler.onUpgrade(res.statusCode, res.rawHeaders.map(value => Buffer.from(value, 'latin1')), socket);
    });
    handler.onConnect(reason => {
      if (upgradedSocket) upgradedSocket.destroy();
      else req.destroy(reason);
    });
    req.end();
    return true;
  }
};
async function fetchCdpTargets(host, port, timeoutMs) {
  const cleanHost = String(host || '127.0.0.1').replace(/^\[|\]$/g, '');
  if (globalThis.fetch === nativeFetch && isLoopbackHost(host)) {
    const res = await loopbackHttpRequest({ host: cleanHost, port, path: '/json/list', timeoutMs });
    if (!res.ok) throw new Error(`调试接口返回异常 (${res.status})`);
    return res.json();
  }
  const urlHost = cleanHost.includes(':') ? `[${cleanHost}]` : cleanHost;
  const res = await fetch(`http://${urlHost}:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.ok === false) throw new Error(`调试接口返回异常 (${res.status})`);
  return res.json();
}

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'native-ui.js');
const HUB_TITLE_RE = /(?:(?:^| - |\(\d+\) )Antigravity(?:\s*(?:\([^)]+\)|\[[^\]]+\]))?|(?:\s|^)(?:\((?:SSH|WSL):\s*[^)]+\)|\[(?:SSH|WSL):\s*[^\]]+\]))$/;
const HUB_PATH_RE = /^\/(?:c\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}|powertools|customizations|automations)(?:\/|$)/;
const SWARM_TARGET_RE = /^plugin:\/\/swarm--swarm_board-/i;
const isLoopbackHttpsPage = target => {
  try {
    const url = new URL(target.url);
    return target.type === 'page' && url.protocol === 'https:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch { return false; }
};
export const isHubTarget = target => {
  if (!isLoopbackHttpsPage(target)) return false;
  try {
    return HUB_TITLE_RE.test(target.title || '') || HUB_PATH_RE.test(new URL(target.url).pathname);
  } catch { return false; }
};
export const isSwarmTarget = target => target?.type === 'iframe' && SWARM_TARGET_RE.test(target?.url || '');

export function connectCdp(url) {
  ensureLoopbackNoProxyEnv();
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const socket = endpoint.protocol === 'ws:' && isLoopbackHost(endpoint.hostname)
      ? new WebSocket(url, { dispatcher: loopbackWebSocketDispatcher })
      : new WebSocket(url);
    const pending = new Map();
    let sequence = 0;
    const listeners = new Set();
    const timeout = setTimeout(() => { socket.close(); reject(new Error('调试接口连接超时')); }, 4000);
    const close = () => {
      clearTimeout(timeout);
      reject(new Error('调试接口已断开'));
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('调试接口已断开')); }
      pending.clear();
    };
    socket.addEventListener('error', event => {
      clearTimeout(timeout);
      reject(new Error('调试接口不可用', { cause: event.error }));
    });
    socket.addEventListener('close', close);
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const p = pending.get(message.id);
      if (p) {
        clearTimeout(p.timer); pending.delete(message.id);
        if (message.error) p.reject(new Error(message.error.message)); else p.resolve(message.result);
      } else for (const listener of listeners) listener(message);
    });
    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve({
        socket,
        onEvent: listener => listeners.add(listener),
        send(method, params = {}) {
          if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('调试接口已断开'));
          return new Promise((resolve, reject) => {
            const id = ++sequence;
            const timeoutMs = ['Page.captureScreenshot', 'Runtime.evaluate'].includes(method) ? 15000 : 5000;
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)); }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            try {
              socket.send(JSON.stringify({ id, method, params }));
            } catch (error) {
              clearTimeout(timer);
              pending.delete(id);
              reject(error);
            }
          });
        }
      });
    });
  });
}

export function findIdentifier(result, keys = ['conversationId', 'conversation_id', 'cascadeId', 'cascade_id']) {
  if (!result || typeof result !== 'object') return null;
  for (const key of keys) if (typeof result[key] === 'string' && result[key]) return result[key];
  for (const value of Object.values(result)) {
    if (value && typeof value === 'object') { const id = findIdentifier(value, keys); if (id) return id; }
  }
  return null;
}

const nativeDeclarations=createNativeDeclarationCache();
const pluginVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;

function readNativeScripts() {
  const helpers = ['dashboard.mjs', 'cache.mjs', 'account-helpers.mjs', 'zh-tw.mjs']
    .map(name => readFileSync(join(dirname(scriptPath), name), 'utf8').replaceAll('export function', 'function')).join('\n');
  const bindings = readFileSync(join(dirname(scriptPath), 'native-bindings.js'), 'utf8');
  const sshPaste = readFileSync(join(dirname(scriptPath), 'native-ssh-paste.mjs'), 'utf8').replaceAll('export function', 'function');
  const scripts = [sshPaste, ...['native-client.js', 'native-i18n.js', 'calendar-vendor.js', 'prism-panels.js', 'prism-optics.js', 'prism-workbench.js', 'prism-integration.js', 'native-panels.js', 'aux-file-tree.js', 'native-ui.js'].map(name => readFileSync(join(dirname(scriptPath), name), 'utf8'))].join('\n');
  const buildHash = createHash('sha256').update(JSON.stringify([helpers, bindings, scripts])).digest('hex').slice(0, 12);
  return { helpers, bindings, scripts, buildHash };
}

export function nativeSource(origin,declaredNames=[],{priorityState=null}={}) {
  const aliases=['B','HC','IC','JC','KC','GC','Uy','XP','UP','TP','VP','dq','k0','Sy','kT','lT','mT','nT','um','HU','I','tc','Wb','IJ','LN','VD','Wz','YF','MUa','Gy','Shd'];
  const { helpers, bindings, scripts, buildHash } = readNativeScripts();
  const initialPriority = priorityState && typeof priorityState === 'object' ? priorityState : { open: false, entries: [] };
  return `if(location.origin===${JSON.stringify(origin)} && window===window.top && (globalThis.__agyPowertools?.version!==${JSON.stringify(pluginVersion)}||globalThis.__agyPowertools?.buildHash!==${JSON.stringify(buildHash)}||globalThis.__agyPowertools?.status?.healthy===false) && !globalThis.__agyNativeBootPending){
globalThis.__agyNativeBuildHash=${JSON.stringify(buildHash)};
globalThis.__agyNativeDefaults=${JSON.stringify(DEFAULT_SETTINGS)};
globalThis.__agyScenePresets=${JSON.stringify(SCENE_PRESETS)};
globalThis.__agyInitialSettings=${JSON.stringify(createSettingsStore().get())};
globalThis.__agyInitialPriorityState=${JSON.stringify(initialPriority)};
globalThis.__agyProject=${JSON.stringify(projectInfo())};
(()=>{${helpers}
globalThis.__agyToZhTw=toZhTw;
globalThis.__agyDashboard={modelIdentity,timestampToMs,resolveWeeklyQuotaWindow,dateRange,summarizeRequests,subscriptionIdentity,cacheObservation,distributionModels,annotateCacheAnomalies};
globalThis.__agyAccounts={quotaGroupMeta,accountBucketStatus,summarizeAccountQuota,formatRelativeTime,formatResetCountdown,formatCompactCountdown,accountInitials,selectAutoSwitchCandidate};})();
${bindings}
globalThis.__agyNativeBootPending=true;
(()=>{
let retries=0;
const deadline=Date.now()+15000;
function boot(){
  const missing=[];
  if(!document.head)missing.push('document.head');
  if(!document.body)missing.push('document.body');
  if(typeof globalThis.ReactDOM?.createRoot!=='function')missing.push('ReactDOM.createRoot');
  if(typeof globalThis.createFileRoute!=='function')missing.push('createFileRoute');
  if(!document.getElementById?.('root')?.firstElementChild)missing.push('DOM #root');
  if(missing.length){
    if(retries++<150&&Date.now()<deadline){setTimeout(boot,100);return;}
    delete globalThis.__agyNativeBootPending;
    globalThis.__agyCompatibilityError='Missing host bindings: '+missing.join(', ');
    console.error(globalThis.__agyCompatibilityError);
    return;
  }
  try {
    globalThis.__agyPowertools?.dispose();
    const resolved=globalThis.__agyResolveNativeBindings(${JSON.stringify(declaredNames)});
    globalThis.__agyNativeBindings=resolved.bindings;
    globalThis.__agyNativeBindingNames=resolved.names;
    delete globalThis.__agyCompatibilityError;
    (function({${aliases.join(',')}}){
${scripts}
    })(resolved.bindings);
  } catch(error) {
    globalThis.__agyCompatibilityError=error.message;
    console.error(error);
  } finally {
    delete globalThis.__agyNativeBootPending;
  }
}
boot();
})();
}`;
}

export function swarmI18nSource(settingsObj = createSettingsStore().get()) {
  const zhTw = readFileSync(join(dirname(scriptPath), 'zh-tw.mjs'), 'utf8').replaceAll('export function', 'function');
  const i18n = readFileSync(join(dirname(scriptPath), 'native-i18n.js'), 'utf8');
  const initial = {
    enabled: settingsObj?.enabled !== false,
    language: ['zh-CN', 'zh-TW', 'en'].includes(settingsObj?.language) ? settingsObj.language : 'zh-CN'
  };
  return `if(/^plugin:\\/\\/swarm--swarm_board-/i.test(location.href)){\nglobalThis.__agyInitialSettings=${JSON.stringify(initial)};\n(()=>{${zhTw}\nglobalThis.__agyToZhTw=toZhTw;})();\n${i18n}\nglobalThis.__agyLocalization?.apply(globalThis.__agyInitialSettings.enabled?globalThis.__agyInitialSettings.language:'en',false);\n}`;
}

const isTransientTimeoutError = error => {
  const name = error?.name || '';
  const code = error?.code || error?.cause?.code || '';
  return name === 'TimeoutError' || name === 'AbortError' || code === 'ABORT_ERR' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT';
};

async function forEachTarget(targets, visit) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(targets.length, 4) }, async () => {
    while (next < targets.length) await visit(targets[next++]);
  }));
}

// The inspector's status callback projects the legacy fields. Publish the latest
// diagnostics separately so its in-process Web UI can include them in the response.
export let nativeMountDiagnostics;

export function startNativeIntegration({ parseSessionData, portFile, onStatus = console.log, onMissingDebugPort, onDebugPortReady, connect=connectCdp,discover=nativeDeclarations, remoteTelemetry, marketplaceTranslator, wsl = isWslEnvironment(), createCdpBridge = createWslCdpBridge }) {
  const dataDir = join(homedir(),'.gemini','antigravity','plugin_data','agy-max');
  const settings = createSettingsStore();
  const appDir = process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity');
  const prism = createPrismService({ settings, dataDir, workspaceOf: id => readDatabase(appDir, id)?.workspaceUri });
  const mpTranslator = marketplaceTranslator ?? createThoughtTranslator(dataDir, {
    cacheFile: 'marketplace-i18n-cache.json',
    maxCacheEntries: 1200,
    timeoutMs: 12000,
    getSettings: () => settings.get()
  });
  const explorer = createWorkspaceExplorer({ dataDir, appDir });
  const goals = createGoalsStore(dataDir);
  const priority = createPriorityStore(dataDir);
  const priorityScopeFor = sshHost => sshHost ? `ssh:${sshHost}` : 'local';
  const pricing = createPricingStore(dataDir);
  const quota = createQuotaTracker(dataDir);
  const remote = remoteTelemetry ?? createRemoteTelemetryBridge({ onStatus: message => status(message) });
  let wslBridge = null, usingWslBridge = false;
  let relaunchPendingUntil = 0;
  const triggerRelaunch = (options = undefined) => {
    if (Date.now() < relaunchPendingUntil) throw new Error('正在重启 Antigravity，请稍候');
    const res = scheduleRelaunchWithDebugPort({ dataDir, home: installationPaths().home, ...(options || {}) });
    relaunchPendingUntil = Date.now() + 10000;
    return res;
  };
  const accounts = createAccountsStore(dataDir, {
    relaunch: options => triggerRelaunch(options)
  });
  const activePortFile = devToolsPortFile({portFile});
  const clients = new Map();
  const swarmClients = new Map();
  let stopped = false, polling = false, lastStatus = '', debugPortReached = false, lastPageTargets = [];
  let portReachable = false, matchedTargets = 0, mountErrors = new Map(), publishedDiagnostics;
  const status = message => { if (message !== lastStatus) { lastStatus = message; onStatus(`[native-ui] ${message}`); } };
  const knownAccountCount = () => { try { return accounts.list().accounts.length; } catch { return 0; } };
  const syncSwarmLanguage = () => {
    const cur = settings.get();
    const lang = cur.enabled ? cur.language : 'en';
    for (const swarmClient of swarmClients.values()) {
      void swarmClient.send('Runtime.evaluate', {
        expression: `globalThis.__agyLocalization?.apply(${JSON.stringify(lang)},false)`
      }).catch(() => {});
    }
  };
  const attachSwarm = async target => {
    const client = await connect(target.webSocketDebuggerUrl);
    client.endpoint = target.webSocketDebuggerUrl;
    client.url = target.url;
    swarmClients.set(target.id, client);
    client.socket.addEventListener('close', () => { if (swarmClients.get(target.id) === client) swarmClients.delete(target.id); });
    const source = swarmI18nSource(settings.get());
    try {
      await client.send('Page.enable');
      const installed = await client.send('Page.addScriptToEvaluateOnNewDocument', { source });
      client.scriptId = installed?.identifier || '';
    } catch { /* Some iframe targets do not support Page.addScriptToEvaluateOnNewDocument. */ }
    const result = await client.send('Runtime.evaluate', { expression: source });
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text);
  };
  const initializeClient = async (target, client) => {
    const origin = new URL(target.url).origin;
    const mainFrame = (await client.send('Page.getFrameTree')).frameTree.frame.id;
    const contexts = new Set();
    const resolveHost = async () => {
      if (client.sshHost) return client.sshHost;
      if (client.sshKind !== 'ssh') return '';
      try {
        const res = await client.send('Runtime.evaluate', {
          expression: `(async()=>{let sshHost='';const ssh=globalThis.sshRemote;if(ssh?.kind==='ssh'&&typeof ssh.getState==='function'){try{const st=await ssh.getState();if(typeof st?.currentHost==='string')sshHost=st.currentHost.trim();}catch{}}return{sshHost,title:typeof document!=='undefined'?document.title||'':''};})()`,
          awaitPromise: true,
          returnByValue: true
        });
        const v = res.result?.value;
        const found = (v && typeof v === 'object' && v.sshHost ? String(v.sshHost).trim() : '')
          || (v && typeof v === 'object' ? parseSshWindowTitle(v.title) : '');
        if (found) client.sshHost = found;
      } catch { /* Keep unresolved if renderer is navigating. */ }
      return client.sshHost || '';
    };
    client.onEvent(async event => {
      if (event.method === 'Runtime.executionContextCreated') {
        const context = event.params.context;
        if (context.origin === origin && context.auxData?.isDefault && context.auxData.frameId === mainFrame) contexts.add(context.id);
        return;
      }
      if (event.method === 'Runtime.executionContextDestroyed') { contexts.delete(event.params.executionContextId); return; }
      if (event.method === 'Runtime.executionContextsCleared') { contexts.clear(); return; }
      if (event.method !== 'Runtime.bindingCalled' || event.params.name !== '__agyPowertoolsHost') return;
      if (!contexts.has(event.params.executionContextId)) return;
      let envelope;
      // 2 MiB leaves room for a JSON-escaped 512 KB file save from the file tree.
      try { if (event.params.payload.length > 2 * 1024 * 1024) return; envelope = JSON.parse(event.params.payload); } catch { return; }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return;
      const rpcId = Number.isInteger(envelope.__rpcId) ? envelope.__rpcId : envelope.id;
      const rpcMethod = typeof envelope.__rpcMethod === 'string' ? envelope.__rpcMethod : envelope.method;
      if (!Number.isInteger(rpcId) || typeof rpcMethod !== 'string') return;
      const hasIsolatedPayload = Boolean(
        envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload)
        && (Number.isInteger(envelope.__rpcId) || Object.keys(envelope).every(key => key === 'id' || key === 'method' || key === 'payload'))
      );
      const request = hasIsolatedPayload ? { ...envelope.payload, method: rpcMethod } : { ...envelope, method: rpcMethod };
      let reply;
      try {
        if(!settings.get().enabled&&!['settings.get','settings.set','update.check','update.install','update.status'].includes(request.method))throw new Error('Antigravity Max 已关闭');
        if (request.method === 'state') {
          const sshHost = await resolveHost();
          const parsed = sshHost
            ? await remote.state(sshHost, { conversationId: request.conversationId, execution: request.execution })
            : parseSessionData(request.conversationId, { includeSessions: false, strict: true, execution: request.execution });
          const curSettings = settings.get();
          const goal = curSettings.goalBar
            ? syncConversationGoal(request.conversationId, parsed.transcriptGoal, goals, {
                turns: parsed.turns,
                executions: parsed.executions,
                execution: request.execution
              })
            : null;
          reply = { ...parsed, goal, costUsd: estimateRequestsCost(parsed.requests, pricing.get().rates), settings: curSettings };
        }
        else if (request.method === 'goal.save') {
          if (!settings.get().goalBar) throw new Error('目标栏功能已关闭');
          const saved = goals.save(request.conversationId, {
            text: request.text,
            checklist: request.checklist,
            guardrails: request.guardrails,
            sourceStepIndex: request.sourceStepIndex,
            currentStepIndex: request.currentStepIndex,
            startedAtMs: request.startedAtMs
          });
          reply = { ok: true, goal: resolveConversationGoal(null, saved) };
        }
        else if (request.method === 'goal.setStatus') {
          if (!settings.get().goalBar) throw new Error('目标栏功能已关闭');
          const saved = goals.setStatus(request.conversationId, request.status, {
            fallbackText: request.text,
            sourceStepIndex: request.sourceStepIndex,
            currentStepIndex: request.currentStepIndex,
            startedAtMs: request.startedAtMs
          });
          reply = {
            ok: true,
            goal: resolveConversationGoal(request.hadNativeGoal ? { status: 'active', stepIndex: -1 } : null, saved)
          };
        }
        else if (request.method === 'priority.get') {
          const sshHost = await resolveHost();
          reply = priority.get(priorityScopeFor(sshHost));
        }
        else if (request.method === 'priority.save') {
          const sshHost = await resolveHost();
          reply = priority.save(priorityScopeFor(sshHost), { open: request.open, entries: request.entries });
        }
        else if (request.method === 'subagents.stats') {
          const ids = Array.isArray(request.conversationIds)
            ? [...new Set(request.conversationIds.filter(id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)))].slice(0, 32)
            : [];
          const rates = pricing.get().rates;
          const items = {};
          const sshHost = await resolveHost();
          const remoteSessions = sshHost && ids.length ? (await remote.subagents(sshHost, { conversationIds: ids }))?.sessions || {} : null;
          for (const id of ids) {
            try {
              const parsed = remoteSessions ? remoteSessions[id] : parseSessionData(id, { includeSessions: false, strict: true });
              const summary = summarizeSubagentSession(parsed, rates);
              if (summary && (summary.telemetry?.stepCount > 0 || summary.telemetry?.requestCount > 0 || summary.contextWindow?.usedTokens > 0)) {
                items[id] = summary;
              }
            } catch { /* Skip unreadable or uninitialized subagent. */ }
          }
          reply = { items };
        }
        else if (prism.handles(request.method)) {
          const remoteWindow = request.method === 'diff.inline' && (await resolveHost() || client.sshKind === 'ssh');
          reply = await prism.request(request, { remoteWindow });
        }
        else if (request.method === 'settings.get') reply = settings.get();
        else if (request.method === 'settings.set') {
          reply = settings.set(request.settings);
          if (request.settings && (Object.hasOwn(request.settings, 'agyFast') || Object.hasOwn(request.settings, 'enabled'))) {
            try { syncBundledAgyFast({ enabled: Boolean(reply.enabled && reply.agyFast) }); } catch {}
          }
          syncSwarmLanguage();
        }
        else if (request.method === 'dashboard') {
          const sshHost = await resolveHost();
          const activeEmail = typeof request.accountKey === 'string' ? request.accountKey.trim().toLowerCase() : '';
          if (!sshHost && activeEmail) quota.recordAccount(activeEmail, Date.now(), { knownAccountCount: knownAccountCount() });
          const data = sshHost
            ? await remote.dashboard(sshHost, { force: request.force === true })
            : usageDashboard(process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(),'.gemini','antigravity'), { force:request.force===true });
          const prices=pricing.get();
          const annotate = item => (!sshHost ? { ...item, accountEmail: quota.emailAt(item.timestampMs) } : item);
          reply={
            ...data,
            pricing:prices,
            quotaSamples:quota.samples(activeEmail),
            accountEmails:sshHost ? [] : quota.accounts(),
            activeAccountEmail:activeEmail,
            requests:data.requests.map(r=>({...annotate(r),costUsd:estimateCost(r,prices.rates)})),
            errors:(data.errors||[]).map(annotate)
          };
        }
        else if (request.method === 'sessions.search') {
          if (!settings.get().sessionSearch) throw new Error('会话搜索已关闭');
          const sshHost = await resolveHost();
          const searchParams = {
            query: typeof request.query === 'string' ? request.query : '',
            scope: request.scope,
            conversationIds: Array.isArray(request.conversationIds) ? request.conversationIds : undefined,
            excludeIds: Array.isArray(request.excludeIds) ? request.excludeIds : undefined,
            maxResults: request.maxResults
          };
          reply = sshHost
            ? await remote.search(sshHost, searchParams)
            : searchTranscripts(searchParams.query, searchParams);
        }
        else if (request.method === 'sessions.markdown') {
          if (!settings.get().copySessionMarkdown) throw new Error('复制会话为 Markdown 功能已关闭');
          const sshHost = await resolveHost();
          const mdParams = {
            conversationId: typeof request.conversationId === 'string' ? request.conversationId : '',
            upToTurn: request.upToTurn ?? null,
            title: typeof request.title === 'string' ? request.title.slice(0, 160) : '',
            language: settings.get().language || 'zh-CN'
          };
          reply = sshHost
            ? await remote.markdown(sshHost, mdParams)
            : formatConversationMarkdown(mdParams.conversationId, mdParams);
        }
        else if (request.method === 'update.check') reply = await checkForUpdates({currentVersion:pluginVersion});
        else if (request.method === 'update.install') reply = await startUpdate({currentVersion:pluginVersion,expectedVersion:request.version});
        else if (request.method === 'update.status') reply = updateStatus();
        else if (request.method === 'pricing.refresh') reply = await pricing.refresh();
        else if (request.method === 'quota.observe') reply = quota.observe(request.groups,usageDashboard(process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(),'.gemini','antigravity'), { force: true }).requests,pricing.get().rates,Date.now(),request.accountKey,{ knownAccountCount: knownAccountCount() });
        else if (typeof request.method === 'string' && request.method.startsWith('accounts.')) {
          if (!settings.get().multiAccount) throw new Error('多账号切换未启用');
          if (request.method === 'accounts.list') reply = accounts.list();
          else if (request.method === 'accounts.syncActive') {
            reply = accounts.syncActive(request.snapshot);
            if (request.snapshot?.email && !reply?.credentialMismatch) quota.recordAccount(request.snapshot.email, Date.now(), { knownAccountCount: reply?.accounts?.length || knownAccountCount() });
          }
          else if (request.method === 'accounts.prepareAdd') reply = accounts.prepareAdd({ pendingAlias: request.pendingAlias });
          else if (request.method === 'accounts.completeAdd') {
            reply = accounts.completeAdd({
              email: request.email,
              prevEmail: request.prevEmail,
              prevCredHash: request.prevCredHash,
              triggerRelaunch: request.relaunch !== false
            });
            if (reply?.account?.email && !reply?.credentialMismatch && (reply.accountChanged || reply.relaunching || reply.manualRestartRequired)) quota.recordAccount(reply.account.email, Date.now(), { knownAccountCount: reply?.accounts?.length || knownAccountCount() });
          }
          else if (request.method === 'accounts.switch') {
            reply = accounts.switchAccount(request.accountId, { auto: request.auto === true, triggerRelaunch: request.relaunch !== false });
            if (reply?.account?.email) quota.recordAccount(reply.account.email, Date.now(), { knownAccountCount: reply?.accounts?.length || knownAccountCount() });
          }
          else if (request.method === 'accounts.rename') reply = accounts.renameAccount(request.accountId, request.alias);
          else if (request.method === 'accounts.setDisabled') reply = accounts.setDisabled(request.accountId, request.disabled);
          else if (request.method === 'accounts.reorder') reply = accounts.reorderAccounts(request.orderedIds);
          else if (request.method === 'accounts.refreshCredentials') reply = accounts.refreshCredentials({ accountId: request.accountId || '' });
          else if (request.method === 'accounts.refreshLocalQuotas') reply = accounts.refreshLocalQuotas({ accountId: request.accountId || '' });
          else if (request.method === 'accounts.remove') reply = accounts.removeAccount(request.accountId);
          else if (request.method === 'accounts.autoSwitchCandidate') reply = accounts.pickAutoSwitch(request.depletedGroupKey);
          else throw new Error('不支持的操作');
        }
        else if (request.method === 'proxy.status') {
          reply = {
            ...inspectProxyRuntime(settings.get(), process.env),
            canRelaunch: !isRemoteSshEnvironment(),
            relaunching: Date.now() < relaunchPendingUntil
          };
        }
        else if (request.method === 'proxy.test') {
          const targetUrl = typeof request.proxyUrl === 'string' ? request.proxyUrl : settings.get().proxyUrl;
          const probed = await probeProxyConnectivity(targetUrl);
          reply = { ok: probed.ok, reachable: probed.reachable, tunnelOk: probed.tunnelOk, latencyMs: probed.latencyMs, statusCode: probed.statusCode, url: probed.url, message: probed.error || '' };
        }
        else if (request.method === 'proxy.relaunch') {
          if (isRemoteSshEnvironment()) throw new Error('SSH 远端模式不支持重启本地客户端');
          const current = settings.get();
          if (current.proxyEnabled && current.proxyUrl && request.force !== true) {
            const portCheck = await checkProxyPortOpen(current.proxyUrl, 900);
            if (!portCheck.ok) {
              reply = { ok: false, portUnreachable: true, message: portCheck.error, host: portCheck.host, port: portCheck.port };
            } else {
              const launched = triggerRelaunch();
              reply = { ok: true, relaunching: Boolean(launched.scheduled), proxyActive: Boolean(launched.proxyActive) };
            }
          } else {
            const launched = triggerRelaunch();
            reply = { ok: true, relaunching: Boolean(launched.scheduled), proxyActive: Boolean(launched.proxyActive) };
          }
        }
        else if (request.method === 'file.open') {
          if (!settings.get().fileContextMenu && request.source !== 'file-tree') throw new Error('文件右键菜单已关闭');
          if (await resolveHost()) throw new Error('SSH 远端文件暂不支持在本地直接打开，请使用“复制路径”');
          reply = await openLocalFile(request.uri, { action: 'open' });
        }
        else if (request.method === 'file.openEditor') {
          const current = settings.get();
          if (!current.fileContextMenu && request.source !== 'git' && request.source !== 'file-tree') throw new Error('文件右键菜单已关闭');
          if (await resolveHost()) throw new Error('SSH 远端文件暂不支持在本地编辑器直接打开，请使用“复制路径”');
          reply = await openInExternalEditor(request.uri, {
            preferred: current.externalEditor || 'auto',
            line: request.line ?? null,
            column: request.column ?? null
          });
        }
        else if (request.method === 'file.reveal') {
          if (!settings.get().fileContextMenu) throw new Error('文件右键菜单已关闭');
          if (await resolveHost()) throw new Error('SSH 远端文件暂不支持在本地直接打开，请使用“复制路径”');
          reply = await openLocalFile(request.uri, { action: 'reveal' });
        }
        else if (request.method === 'file.copy') {
          if (!settings.get().fileContextMenu) throw new Error('文件右键菜单已关闭');
          if (await resolveHost()) throw new Error('SSH 远端文件暂不支持在本地直接打开，请使用“复制路径”');
          reply = await copyLocalFile(request.uri);
        }
        else if (request.method === 'file.path') {
          if (!settings.get().fileContextMenu) throw new Error('文件右键菜单已关闭');
          const sshHost = await resolveHost();
          reply = { ok: true, path: sshHost ? resolveRemotePosixPath(request.uri) : await resolveVerifiedLocalFilePath(request.uri) };
        }
        else if (request.method === 'git.status') {
          if (!settings.get().gitStatusPill) {
            reply = { ok: true, isRepo: false };
          } else if (await resolveHost()) {
            reply = { ok: true, isRepo: false, sshUnsupported: true };
          } else {
            let wsUri = typeof request.workspaceUri === 'string' ? request.workspaceUri.trim() : '';
            if (!wsUri && typeof request.conversationId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(request.conversationId)) {
              const appDir = process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity');
              wsUri = readDatabase(appDir, request.conversationId)?.workspaceUri || '';
            }
            reply = wsUri ? await readGitStatus(wsUri, { force: request.force === true }) : { ok: true, isRepo: false };
          }
        }
        else if (request.method === 'git.diff') {
          if (!settings.get().gitStatusPill) throw new Error('Git 状态胶囊已关闭');
          if (await resolveHost()) throw new Error('SSH 远端窗口暂不支持本地 Git 差异预览');
          let wsUri = typeof request.workspaceUri === 'string' ? request.workspaceUri.trim() : '';
          if (!wsUri && typeof request.conversationId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(request.conversationId)) {
            const appDir = process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity');
            wsUri = readDatabase(appDir, request.conversationId)?.workspaceUri || '';
          }
          reply = await readGitFileDiff(wsUri, request.path, { status: request.status || '' });
        }
        else if (request.method === 'file.attach') {
          if (!settings.get().fileContextMenu && request.source !== 'git' && request.source !== 'file-tree') throw new Error('文件右键菜单已关闭');
          const sshHost = await resolveHost();
          if (sshHost) {
            const remotePath = resolveRemotePosixPath(request.uri);
            const cleanUri = String(request.uri || '').trim();
            const name = remotePath.split('/').filter(Boolean).pop() || remotePath;
            reply = { ok: true, mode: 'mention', kind: request.isDirectory ? 'directory' : 'file', uri: cleanUri, path: remotePath, name, isDirectory: Boolean(request.isDirectory) };
          } else {
            reply = await readLocalFileForAttach(request.uri);
          }
        }
        else if (request.method === 'workspace.recent') {
          if (await resolveHost()) reply = { ok: true, sshRemote: true, workspaces: [] };
          else reply = { ok: true, workspaces: explorer.recentWorkspaces({ clientWorkspaces: request.clientWorkspaces }) };
        }
        else if (request.method === 'workspace.mount') {
          if (await resolveHost()) throw new Error('SSH 远端窗口请使用客户端原生远程工作区');
          reply = explorer.mountWorkspace(request.uri);
        }
        else if (request.method === 'workspace.listDir') {
          if (await resolveHost()) throw new Error('SSH 远端窗口暂不支持本地文件树读取');
          reply = explorer.listDir({ rootUri: request.rootUri, relPath: request.relPath });
        }
        else if (request.method === 'workspace.searchFiles') {
          if (await resolveHost()) throw new Error('SSH 远端窗口暂不支持本地文件筛选');
          reply = explorer.searchFiles({ rootUri: request.rootUri, query: request.query, limit: request.limit });
        }
        else if (request.method === 'workspace.readFile') {
          if (await resolveHost()) throw new Error('SSH 远端窗口暂不支持本地文件预览');
          reply = explorer.readFilePreview({ rootUri: request.rootUri, fileUri: request.fileUri });
        }
        else if (request.method === 'workspace.writeFile') {
          if (await resolveHost()) throw new Error('SSH 远端窗口暂不支持本地文件编辑');
          reply = explorer.writeTextFile({ rootUri: request.rootUri, fileUri: request.fileUri, content: request.content, expectedMtimeMs: request.expectedMtimeMs, overwrite: request.overwrite === true });
        }
        else if (request.method === 'workspace.pickFolder') {
          if (await resolveHost()) throw new Error('SSH 远端窗口不支持打开本机文件夹选择器');
          reply = await explorer.pickFolder();
        }
        else if (request.method === 'ssh.saveConfigHost') {
          if (!settings.get().sshCommandPaste) throw new Error('SSH 命令识别已关闭');
          if (await resolveHost()) throw new Error('仅支持在本地窗口保存 ~/.ssh/config');
          reply = saveHostToSshConfig({
            alias: request.alias,
            host: request.host,
            user: request.user,
            port: request.port,
            identityFile: request.identityFile,
            proxyJump: request.proxyJump,
            forwardAgent: request.forwardAgent
          });
        }
        else if (request.method === 'marketplace.translate') {
          const cur = settings.get();
          if (!cur.marketplaceTranslate) {
            reply = { ok: true, translations: {} };
          } else {
            reply = await mpTranslator.translateBatch({
              texts: Array.isArray(request.texts) ? request.texts : [],
              mode: 'machine',
              targetLang: 'zh-CN'
            });
          }
        }
        else throw new Error('不支持的操作');
      } catch (error) { reply = { error: error.message }; }
      try {
        await client.send('Runtime.evaluate', {
          expression: `globalThis.__agyPowertoolsReceive?.(${JSON.stringify(rpcId)},${JSON.stringify(reply)})`,
          contextId: event.params.executionContextId
        });
      } catch { /* Navigation invalidates the old context. */ }
    });
    await client.send('Runtime.enable');
    await client.send('Runtime.addBinding', { name: '__agyPowertoolsHost' });
    const agent = await client.send('Runtime.evaluate', {
      expression: `(async()=>{const ua=navigator.userAgent||'';const ssh=globalThis.sshRemote;let sshHost='';if(ssh?.kind==='ssh'&&typeof ssh.getState==='function'){try{const st=await ssh.getState();if(typeof st?.currentHost==='string')sshHost=st.currentHost.trim();}catch{}}const isHub=Boolean(/Antigravity\\//.test(ua)||globalThis.electronNative||globalThis.sshRemote||globalThis.createFileRoute);return{ua,isHub,sshKind:ssh?.kind||'',sshHost,title:typeof document!=='undefined'?document.title||'':''};})()`,
      awaitPromise: true,
      returnByValue: true
    });
    const probe = agent.result?.value;
    if (probe && typeof probe === 'object' && probe.isHub === false) {
      throw new Error('调试目标不是 Antigravity 主窗口');
    }
    const ua = typeof probe === 'string' ? probe : (probe && typeof probe === 'object' ? String(probe.ua || '') : '');
    const version = ua.match(/Antigravity\/([0-9.]+)/)?.[1] || 'unknown';
    client.sshKind = probe && typeof probe === 'object' ? String(probe.sshKind || '') : '';
    client.sshHost = (probe && typeof probe === 'object' && probe.sshHost ? String(probe.sshHost).trim() : '')
      || parseSshWindowTitle(target.title)
      || (probe && typeof probe === 'object' ? parseSshWindowTitle(probe.title) : '');
    const fallbackFetch = async (_origin, reqHeaders = {}) => {
      const fetchInit = reqHeaders && Object.keys(reqHeaders).length ? `,${JSON.stringify({ headers: reqHeaders })}` : '';
      const fetched = await client.send('Runtime.evaluate', {
        expression: `fetch('/main.js'${fetchInit}).then(async r=>({status:r.status,source:r.ok?await r.text():'',headers:{etag:r.headers.get('etag')||undefined,'last-modified':r.headers.get('last-modified')||undefined}}))`,
        awaitPromise: true, returnByValue: true
      });
      if (fetched.exceptionDetails || !fetched.result?.value) throw new Error('页面上下文读取原生界面组件失败');
      return fetched.result.value;
    };
    const isRemoteTarget = Boolean(client.sshHost || client.sshKind === 'ssh');
    client.declaredNames = await discover(origin, {
      version,
      fallbackFetch,
      ...(isRemoteTarget ? { cacheScope: 'ssh', preferFallback: true } : usingWslBridge ? { preferFallback: true } : {})
    });
    const source = nativeSource(origin, client.declaredNames, {
      priorityState: priority.get(priorityScopeFor(client.sshHost))
    });
    client.origin = origin;
    client.endpoint=target.webSocketDebuggerUrl;
    await client.send('Page.enable');
    const installed = await client.send('Page.addScriptToEvaluateOnNewDocument', { source });
    client.scriptId = installed.identifier;
    const result = await client.send('Runtime.evaluate', { expression: source });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  };
  const attach = async target => {
    const client = await connect(target.webSocketDebuggerUrl);
    let handedOff = false;
    try {
      await initializeClient(target, client);
      if (stopped) return;
      if (client.socket.readyState != null && client.socket.readyState !== WebSocket.OPEN) {
        throw new Error('调试接口已断开');
      }
      client.socket.addEventListener('close', () => {
        if (clients.get(target.id) === client) clients.delete(target.id);
      });
      clients.set(target.id, client);
      handedOff = true;
    } finally {
      if (!handedOff) client.socket.close();
    }
    status('已接入原生输入框');
  };
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      const port = Number(readFileSync(activePortFile, 'utf8').split('\n')[0]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('调试端口不可用');
      let targets;
      let directErr = null;
      if (!usingWslBridge) {
        try {
          targets = await fetchCdpTargets('127.0.0.1', port, wsl ? 1500 : 5000);
        } catch (err) {
          directErr = err;
          if (!wsl) throw err;
        }
      }
      if (!targets && wsl) {
        try {
          if (!wslBridge) wslBridge = createCdpBridge();
          const ep = await wslBridge.endpointFor(port);
          const rawTargets = await fetchCdpTargets(ep.host, ep.port, 5000);
          if (!Array.isArray(rawTargets)) throw new Error('调试接口返回格式异常');
          targets = wslBridge.rewriteTargets(rawTargets, port);
          usingWslBridge = true;
        } catch (bridgeErr) {
          usingWslBridge = false;
          throw directErr || bridgeErr;
        }
      }
      if (!Array.isArray(targets)) throw new Error('调试接口返回格式异常');
      debugPortReached = true;
      portReachable = true;
      try { onDebugPortReady?.(); } catch {}
      const hubs = targets.filter(t => isHubTarget(t) || (isLoopbackHttpsPage(t) && clients.get(t.id)?.origin === new URL(t.url).origin));
      lastPageTargets = targets.filter(isLoopbackHttpsPage).map(t => ({ title: String(t.title || ''), matched: hubs.includes(t) }));
      matchedTargets = hubs.length;
      const nextMountErrors = new Map();
      await forEachTarget(hubs, async target => {
        if (stopped) return;
        let client = clients.get(target.id);
        try {
          if(client&&(client.origin!==new URL(target.url).origin||client.endpoint!==target.webSocketDebuggerUrl)){
            client.socket.close();clients.delete(target.id);client=null;
          }
          if (!client) await attach(target);
          else if (Date.now() >= (client.retryAfter || 0)) {
            // A live CDP connection does not guarantee that its renderer survived or matches current buildHash.
            const { buildHash } = readNativeScripts();
            const result = await client.send('Runtime.evaluate', {
              expression: `location.origin===${JSON.stringify(client.origin)} && (!globalThis.__agyPowertools||globalThis.__agyPowertools.buildHash!==${JSON.stringify(buildHash)}||globalThis.__agyPowertools.status?.healthy===false) && !globalThis.__agyNativeBootPending && !globalThis.__agyPowertoolsPending && document.readyState!=='loading'`,
              returnByValue: true
            });
            if (result.result?.value === true) {
              const nextSource = nativeSource(client.origin, client.declaredNames, {
                priorityState: priority.get(priorityScopeFor(client.sshHost))
              });
              try {
                if (client.scriptId) await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: client.scriptId });
                const installed = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: nextSource });
                client.scriptId = installed?.identifier || '';
              } catch {}
              const restored = await client.send('Runtime.evaluate', { expression: nextSource });
              if (restored.exceptionDetails) throw new Error(restored.exceptionDetails.text);
              client.retryAfter = Date.now() + 15000;
              status('已热更新原生控件');
            }
          }
        } catch (error) {
          clients.get(target.id)?.socket.close();
          clients.delete(target.id);
          nextMountErrors.set(target.id, error.message);
          status(error.message);
        }
      });
      mountErrors = new Map(hubs.filter(target => nextMountErrors.has(target.id)).map(target => [target.id, nextMountErrors.get(target.id)]));
      const ids = new Set(hubs.map(t => t.id));
      for (const [id, client] of clients) if (!ids.has(id)) { client.socket.close(); clients.delete(id); }
      const swarms = targets.filter(isSwarmTarget);
      await forEachTarget(swarms, async target => {
        if (stopped) return;
        let swarmClient = swarmClients.get(target.id);
        try {
          if (swarmClient && (swarmClient.url !== target.url || swarmClient.endpoint !== target.webSocketDebuggerUrl)) {
            swarmClient.socket.close(); swarmClients.delete(target.id); swarmClient = null;
          }
          if (!swarmClient) await attachSwarm(target);
          else {
            const cur = settings.get();
            const wantLang = cur.enabled ? cur.language : 'en';
            const check = await swarmClient.send('Runtime.evaluate', {
              expression: `({ready:Boolean(globalThis.__agyLocalization),lang:globalThis.__agyLocalization?.language||''})`,
              returnByValue: true
            });
            const v = check?.result?.value;
            if (!v?.ready) {
              await swarmClient.send('Runtime.evaluate', { expression: swarmI18nSource(cur) });
            } else if (v.lang !== wantLang) {
              await swarmClient.send('Runtime.evaluate', { expression: `globalThis.__agyLocalization?.apply(${JSON.stringify(wantLang)},false)` });
            }
          }
        } catch { swarmClients.get(target.id)?.socket.close(); swarmClients.delete(target.id); }
      });
      const swarmIds = new Set(swarms.map(t => t.id));
      for (const [id, swarmClient] of swarmClients) if (!swarmIds.has(id)) { swarmClient.socket.close(); swarmClients.delete(id); }
      if (!hubs.length) status('等待 Antigravity 窗口');
    } catch (error) {
      portReachable = false;
      matchedTargets = 0;
      mountErrors = new Map();
      lastPageTargets = [];
      status('等待 Antigravity 本地调试接口');
      if (!debugPortReached && !clients.size && !isTransientTimeoutError(error)) {
        try { onMissingDebugPort?.(); } catch {}
      }
    }
    finally { polling = false; }
  };
  const timer = setInterval(poll, 4000);
  const initialPoll=poll();
  const stop = async ({purge=false}={}) => {
    stopped = true; clearInterval(timer);
    if (nativeMountDiagnostics === publishedDiagnostics) nativeMountDiagnostics = undefined;
    for (const client of clients.values()) {
      try {
        await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: client.scriptId });
        if(purge)await client.send('Runtime.evaluate',{expression:`(async()=>{if(location.pathname==='/powertools')await globalThis.__agyNativeAdapter?.router()?.navigate({to:'/customizations'});localStorage.removeItem('agy-powertools-language');localStorage.removeItem('agy-marketplace-i18n-v1');})()`,awaitPromise:true});
        await client.send('Runtime.evaluate', { expression: 'globalThis.__agyPowertools?.dispose()' });
      } catch {}
      client.socket.close();
    }
    clients.clear();
    for (const swarmClient of swarmClients.values()) {
      try {
        if (swarmClient.scriptId) await swarmClient.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: swarmClient.scriptId });
        await swarmClient.send('Runtime.evaluate', { expression: 'globalThis.__agyLocalization?.dispose()' });
      } catch {}
      swarmClient.socket.close();
    }
    swarmClients.clear();
    await wslBridge?.close?.();
    wslBridge = null;
    await remote?.close?.();
  };
  stop.fork = async (conversationId, stepIndex = -1) => {
    for (const client of clients.values()) {
      const result = await client.send('Runtime.evaluate', {
        expression: `globalThis.__agyNativeAdapter.fork(${JSON.stringify(conversationId)},${JSON.stringify(stepIndex)})`,
        awaitPromise: true, returnByValue: true
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    }
    throw new Error('请先打开 Antigravity 会话窗口');
  };
  stop.ready=initialPoll;
  stop.check=poll;
  stop.health=async()=>{
    await initialPoll;
    const entries = [...clients];
    const discovery = { portReachable, matchedTargets, pageTargets: lastPageTargets };
    const failures = new Map(mountErrors);
    const results = new Map();
    await forEachTarget(entries, async ([id, client]) => {
      try {
        const result = await client.send('Runtime.evaluate', {
          expression: `({version:globalThis.__agyPowertools?.version,healthy:globalThis.__agyPowertools?.status?.healthy,mounted:globalThis.__agyPowertools?.status?.mounted,conversationId:globalThis.__agyPowertools?.status?.conversationId||'',compatibilityError:globalThis.__agyCompatibilityError||'',renderError:globalThis.__agyPowertools?.status?.error||'',bootPending:Boolean(globalThis.__agyNativeBootPending||globalThis.__agyPowertoolsPending||document.readyState==='loading'),clientVersion:navigator.userAgent.match(/Antigravity\\/([0-9.]+)/)?.[1]||''})`,
          returnByValue: true
        });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        results.set(id, result.result?.value);
      } catch (error) {
        failures.set(id, error.message);
      }
    });
    let compatibilityError = '', clientVersion = '', mountedCount = 0;
    const windows = [];
    for (const [id, client] of entries) {
      if (!results.has(id)) continue;
      const value = results.get(id);
      const healthy = Boolean(value?.version === pluginVersion && value?.healthy);
      if (value?.clientVersion && !clientVersion) clientVersion = String(value.clientVersion);
      if (healthy) mountedCount++;
      else if (value?.compatibilityError || !value?.bootPending) {
        if (value?.compatibilityError && !compatibilityError) compatibilityError = String(value.compatibilityError);
        failures.set(id, value?.compatibilityError || value?.renderError || '原生界面尚未挂载');
      }
      windows.push({
        sshHost: client.sshHost || null,
        healthy,
        mounted: Number(value?.mounted) || 0,
        conversationId: String(value?.conversationId || '')
      });
    }
    const diagnostics = {
      portReachable: discovery.portReachable,
      matchedTargets: discovery.matchedTargets,
      mountedCount: discovery.portReachable ? mountedCount : 0,
      failedCount: discovery.portReachable ? failures.size : 0,
      firstError: discovery.portReachable ? failures.values().next().value || '' : ''
    };
    if (!stopped) nativeMountDiagnostics = publishedDiagnostics = diagnostics;
    return {
      healthy: mountedCount > 0,
      compatibilityError: mountedCount ? '' : compatibilityError,
      clientVersion,
      connected: entries.length > 0,
      windows,
      pageTargets: discovery.pageTargets,
      ...diagnostics
    };
  };
  return stop;
}
