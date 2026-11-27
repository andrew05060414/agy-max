import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { toZhTw } from './zh-tw.mjs';
import { nativeMountDiagnostics } from './native-host.mjs';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeInlineJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function tokensMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function findPreloadJs(env) {
  const candidates = [
    env.ANTIGRAVITY_APP_DATA_DIR && join(env.ANTIGRAVITY_APP_DATA_DIR, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
    join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js')
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) {
      try { return readFileSync(path, 'utf8'); } catch {}
    }
  }
  return '';
}

function readJsonBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('请求格式无效')); }
    });
    req.on('error', reject);
  });
}

export function renderAuxPaneHtml({ version = '', language = 'zh-CN', fallbackToken = '' } = {}) {
  const initialLang = ['zh-CN', 'zh-TW', 'en'].includes(language) ? language : 'zh-CN';
  const zhTwCopy = {
    upgradeTitle: toZhTw('需要重启 Antigravity 以启用 Antigravity Max 插件'),
    upgradeDesc: toZhTw('当前客户端未开启本地调试端口（首次安装、客户端升级或从无参数快捷方式启动时会出现）。后台已尝试自动修复常用快捷方式，点击下方按钮可带参数重启；若无法自动重启，请完全退出客户端后从快捷方式或终端手动启动。'),
    waitingTitle: toZhTw('调试端口已连通，正在等待主窗口就绪'),
    waitingDesc: toZhTw('打开 Antigravity 主窗口后，插件会自动尝试挂载。'),
    mountingTitle: toZhTw('正在挂载 Antigravity 主窗口'),
    mountingDesc: toZhTw('调试端口已连通，插件会自动重试尚未挂载的窗口。'),
    partialTitle: toZhTw('Antigravity Max 已挂载部分窗口'),
    mountedWindows: toZhTw('已挂载的窗口'),
    compatTitlePrefix: toZhTw('检测到 Antigravity '),
    compatTitleSuffix: toZhTw(' 与当前插件暂不兼容'),
    compatTitleFallback: toZhTw('检测到 Antigravity 升级导致当前插件暂不兼容'),
    compatDesc: toZhTw('客户端升级后部分原生界面组件发生变化，右侧栏「插件 -> Antigravity Max」完整面板暂时无法挂载。无需手动重装，可直接在此处检查并一键更新到适配版本。'),
    activeTitle: toZhTw('Antigravity Max 运行正常'),
    activeDesc: toZhTw('原生输入框圆环、紧凑排版、原位消息编辑与右侧栏「插件 -> Antigravity Max」完整面板均已启用。'),
    disabledTitle: toZhTw('Antigravity Max 当前已暂停'),
    disabledDesc: toZhTw('可在右侧栏「插件 -> Antigravity Max」设置页中重新开启总开关。'),
    sshTitle: toZhTw('当前处于 SSH 远端模式'),
    sshDesc: toZhTw('远端主机上没有本地 Antigravity 桌面调试接口，远端服务无法直接接管本地客户端界面。请在本地桌面端安装 Antigravity Max，开启本地客户端后即可自动增强远程 SSH 窗口并实时同步远端会话统计。'),
    relaunch: toZhTw('立即重启启用'),
    relaunching: toZhTw('正在重启 Antigravity…'),
    relaunchSent: toZhTw('已触发后台重启，正在关闭并重新打开 Antigravity，请稍候…'),
    relaunchTimeout: toZhTw('等待重启超时，请完全退出 Antigravity（含系统托盘）后从桌面/开始菜单快捷方式重新打开，或在终端运行下方命令。'),
    relaunchFailed: toZhTw('自动重启失败，请完全退出 Antigravity 后手动重新打开，或在终端运行下方命令。'),
    macDockHint: toZhTw('macOS 提示：可将启动器拖入 Dock 栏替换原 Antigravity 图标（已自动配置原版图标），后续直接从 Dock 启动即可自动启用插件：'),
    copyCmd: toZhTw('复制启动命令'),
    copiedCmd: toZhTw('已复制命令'),
    copyDiag: toZhTw('复制诊断信息'),
    copiedDiag: toZhTw('已复制诊断信息'),
    copyFailed: toZhTw('复制失败，请手动复制所选文本'),
    checkUpdate: toZhTw('检查插件更新'),
    checkingUpdate: toZhTw('正在检查更新…'),
    installUpdatePrefix: toZhTw('立即更新到 v'),
    installUpdateFallback: toZhTw('立即更新'),
    updating: toZhTw('正在更新…'),
    openDownload: toZhTw('打开下载页'),
    upToDate: toZhTw('已是最新版本'),
    upToDateCompat: toZhTw('已是当前最新版本（如刚升级 Antigravity，请稍候作者发布适配版后再次检查）'),
    availablePrefix: toZhTw('发现适配新版 v'),
    availableSuffix: toZhTw('，点击下方按钮即可一键校验更新。'),
    checkFailed: toZhTw('检查更新失败，请检查网络连接或稍后重试。'),
    rateLimited: toZhTw('检查次数过多，请稍后重试。'),
    noRelease: toZhTw('暂未检测到可用正式版本。'),
    progress: {
      preparing: toZhTw('正在准备更新…'),
      downloading: toZhTw('正在下载安装包…'),
      verifying: toZhTw('正在校验 SHA-256…'),
      installing: toZhTw('正在安装并启动新版本…'),
      completed: toZhTw('更新完成，插件正在重新接入窗口…'),
      'rolled-back': toZhTw('更新启动失败，已自动回滚至旧版本。'),
      failed: toZhTw('更新失败，请稍后重试。')
    }
  };
  return `<!doctype html>
<html lang="${initialLang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Antigravity Max</title>
  <script src="/preload.js"></script>
  <style>
    :root {
      color-scheme: light dark;
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body {
      margin: 0;
      padding: 16px;
      background: var(--background, #fafafa);
      color: var(--foreground, #1f2328);
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .card {
      border: 1px solid var(--border, rgba(127, 127, 127, 0.22));
      background: var(--card, rgba(127, 127, 127, 0.05));
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 500;
      color: var(--muted-foreground, #667085);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #f59e0b;
      flex-shrink: 0;
    }
    .dot[data-healthy="true"] {
      background: #16a34a;
    }
    .dot[data-state="incompatible"] {
      background: #dc2626;
    }
    h1 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      line-height: 1.45;
    }
    p {
      margin: 0;
      font-size: 12px;
      color: var(--muted-foreground, #667085);
      line-height: 1.55;
    }
    button, a.btn {
      appearance: none;
      border: 0;
      border-radius: 8px;
      padding: 8px 14px;
      font: inherit;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      background: var(--primary, #2563eb);
      color: var(--primary-foreground, #ffffff);
      transition: opacity 120ms ease;
      align-self: flex-start;
    }
    button:hover:not(:disabled), a.btn:hover { opacity: 0.9; }
    button:disabled { opacity: 0.6; cursor: default; }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    button.secondary, a.btn.secondary {
      background: var(--secondary, rgba(127, 127, 127, 0.14));
      color: var(--foreground, #1f2328);
    }
    .cmd-box {
      font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      padding: 8px 10px;
      border-radius: 8px;
      background: var(--secondary, rgba(127, 127, 127, 0.1));
      color: var(--foreground, #1f2328);
      word-break: break-all;
      user-select: all;
    }
    textarea.cmd-box { box-sizing: border-box; width: 100%; }
    .meta {
      font-size: 11px;
      color: var(--muted-foreground, #667085);
      font-variant-numeric: tabular-nums;
      line-height: 1.5;
    }
    .update-box {
      border-top: 1px solid var(--border, rgba(127, 127, 127, 0.18));
      padding-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .update-notes {
      margin: 0;
      padding: 8px 10px;
      border-radius: 8px;
      background: var(--secondary, rgba(127, 127, 127, 0.08));
      color: var(--muted-foreground, #667085);
      font: 11px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 140px;
      overflow: auto;
    }
  </style>
</head>
<body>
  <section class="card" id="root">
    <div class="badge"><span class="dot" id="dot"></span><span id="state-text">Antigravity Max ${escapeHtml(version)}</span></div>
    <h1 id="title"></h1>
    <p id="desc"></p>
    <div class="meta" id="mac-dock-hint" hidden></div>
    <div class="cmd-box" id="compat-box" hidden></div>
    <div class="actions" id="primary-actions" hidden>
      <button type="button" id="relaunch-btn" hidden></button>
      <button type="button" id="copy-cmd-btn" class="secondary" hidden></button>
      <button type="button" id="copy-diag-btn" class="secondary" hidden></button>
    </div>
    <div class="cmd-box" id="cmd-box" hidden></div>
    <textarea class="cmd-box" id="copy-fallback" rows="3" readonly hidden></textarea>
    <div class="meta" id="copy-feedback" role="status" hidden></div>
    <div class="meta" id="feedback" hidden></div>
    <div class="update-box" id="update-box">
      <div class="actions">
        <button type="button" id="check-update-btn" class="secondary"></button>
        <button type="button" id="install-update-btn" hidden></button>
        <a id="download-link" class="btn secondary" target="_blank" rel="noopener noreferrer" hidden></a>
      </div>
      <div class="meta" id="update-feedback" hidden></div>
      <pre class="update-notes" id="update-notes" hidden></pre>
    </div>
  </section>
  <script>
    (() => {
      const params = new URLSearchParams(location.search);
      const token = params.get('token') || ${safeInlineJson(fallbackToken)};
      const dot = document.getElementById('dot');
      const title = document.getElementById('title');
      const desc = document.getElementById('desc');
      const macDockHint = document.getElementById('mac-dock-hint');
      const compatBox = document.getElementById('compat-box');
      const primaryActions = document.getElementById('primary-actions');
      const btn = document.getElementById('relaunch-btn');
      const copyBtn = document.getElementById('copy-cmd-btn');
      const copyDiagBtn = document.getElementById('copy-diag-btn');
      const cmdBox = document.getElementById('cmd-box');
      const copyFallback = document.getElementById('copy-fallback');
      const copyFeedback = document.getElementById('copy-feedback');
      const feedback = document.getElementById('feedback');
      const updateBox = document.getElementById('update-box');
      const checkBtn = document.getElementById('check-update-btn');
      const installBtn = document.getElementById('install-update-btn');
      const downloadLink = document.getElementById('download-link');
      const updateFeedback = document.getElementById('update-feedback');
      const updateNotes = document.getElementById('update-notes');

      let currentLang = ${safeInlineJson(initialLang)};
      let manualCommand = '';
      let lastCompatError = '';
      let lastClientVersion = '';
      let autoCheckedCompat = false;
      let busy = false;
      let checkingUpdate = false;
      let installingUpdate = false;
      let availableUpdate = null;
      let relaunchTimer = null;
      let updatePollTimer = null;
      let copySource = null, copyTimer = null;

      const copy = {
        'zh-CN': {
          upgradeTitle: '需要重启 Antigravity 以启用 Antigravity Max 插件',
          upgradeDesc: '当前客户端未开启本地调试端口（首次安装、客户端升级或从无参数快捷方式启动时会出现）。后台已尝试自动修复常用快捷方式，点击下方按钮可带参数重启；若无法自动重启，请完全退出客户端后从快捷方式或终端手动启动。',
          waitingTitle: '调试端口已连通，正在等待主窗口就绪',
          waitingDesc: '打开 Antigravity 主窗口后，插件会自动尝试挂载。',
          mountingTitle: '正在挂载 Antigravity 主窗口',
          mountingDesc: '调试端口已连通，插件会自动重试尚未挂载的窗口。',
          partialTitle: 'Antigravity Max 已挂载部分窗口',
          mountedWindows: '已挂载的窗口',
          compatTitle: ver => ver ? ('检测到 Antigravity ' + ver + ' 与当前插件暂不兼容') : '检测到 Antigravity 升级导致当前插件暂不兼容',
          compatDesc: '客户端升级后部分原生界面组件发生变化，右侧栏「插件 -> Antigravity Max」完整面板暂时无法挂载。无需手动重装，可直接在此处检查并一键更新到适配版本。',
          activeTitle: 'Antigravity Max 运行正常',
          activeDesc: '原生输入框圆环、紧凑排版、原位消息编辑与右侧栏「插件 -> Antigravity Max」完整面板均已启用。',
          disabledTitle: 'Antigravity Max 当前已暂停',
          disabledDesc: '可在右侧栏「插件 -> Antigravity Max」设置页中重新开启总开关。',
          sshTitle: '当前处于 SSH 远端模式',
          sshDesc: '远端主机上没有本地 Antigravity 桌面调试接口，远端服务无法直接接管本地客户端界面。请在本地桌面端安装 Antigravity Max，开启本地客户端后即可自动增强远程 SSH 窗口并实时同步远端会话统计。',
          relaunch: '立即重启启用',
          relaunching: '正在重启 Antigravity…',
          relaunchSent: '已触发后台重启，正在关闭并重新打开 Antigravity，请稍候…',
          relaunchTimeout: '等待重启超时，请完全退出 Antigravity（含系统托盘）后从桌面/开始菜单快捷方式重新打开，或在终端运行下方命令。',
          relaunchFailed: '自动重启失败，请完全退出 Antigravity 后手动重新打开，或在终端运行下方命令。',
          macDockHint: 'macOS 提示：可将启动器拖入 Dock 栏替换原 Antigravity 图标（已自动配置原版图标），后续直接从 Dock 启动即可自动启用插件：',
          copyCmd: '复制启动命令',
          copiedCmd: '已复制命令',
          copyDiag: '复制诊断信息',
          copiedDiag: '已复制诊断信息',
          copyFailed: '复制失败，请手动复制所选文本',
          checkUpdate: '检查插件更新',
          checkingUpdate: '正在检查更新…',
          installUpdate: ver => ver ? ('立即更新到 v' + ver) : '立即更新',
          updating: '正在更新…',
          openDownload: '打开下载页',
          upToDate: '已是最新版本',
          upToDateCompat: '已是当前最新版本（如刚升级 Antigravity，请稍候作者发布适配版后再次检查）',
          available: ver => '发现适配新版 v' + ver + '，点击下方按钮即可一键校验更新。',
          checkFailed: '检查更新失败，请检查网络连接或稍后重试。',
          rateLimited: '检查次数过多，请稍后重试。',
          noRelease: '暂未检测到可用正式版本。',
          progress: {
            preparing: '正在准备更新…',
            downloading: '正在下载安装包…',
            verifying: '正在校验 SHA-256…',
            installing: '正在安装并启动新版本…',
            completed: '更新完成，插件正在重新接入窗口…',
            'rolled-back': '更新启动失败，已自动回滚至旧版本。',
            failed: '更新失败，请稍后重试。'
          }
        },
        'zh-TW': (() => {
          const d = ${safeInlineJson(zhTwCopy)};
          return {
            ...d,
            compatTitle: ver => ver ? (d.compatTitlePrefix + ver + d.compatTitleSuffix) : d.compatTitleFallback,
            installUpdate: ver => ver ? (d.installUpdatePrefix + ver) : d.installUpdateFallback,
            available: ver => d.availablePrefix + ver + d.availableSuffix
          };
        })(),
        en: {
          upgradeTitle: 'Restart Antigravity to enable Antigravity Max',
          upgradeDesc: 'Antigravity was launched without its local debugging port (common after a fresh install, client update, or launching from an unpatched shortcut). Click below to relaunch with debugging enabled, or quit Antigravity completely and reopen it from your shortcut or terminal.',
          waitingTitle: 'Debug port connected. Waiting for the main window',
          waitingDesc: 'Antigravity Max will attach when the main window opens.',
          mountingTitle: 'Attaching to Antigravity windows',
          mountingDesc: 'The debug port is connected. Antigravity Max will retry any remaining windows.',
          partialTitle: 'Antigravity Max has attached to some windows',
          mountedWindows: 'Windows attached',
          compatTitle: ver => ver ? ('Antigravity ' + ver + ' is not compatible with this plugin version') : 'Antigravity update broke plugin compatibility',
          compatDesc: 'Native UI bindings changed after the client update, so the full Antigravity Max panel in the right side panel is temporarily unavailable. Check and install a compatible update directly from here without reinstalling manually.',
          activeTitle: 'Antigravity Max is active',
          activeDesc: 'Context ring, compact layout, in-place message editing, and the full Antigravity Max panel under Plugins in the right side panel are running.',
          disabledTitle: 'Antigravity Max is paused',
          disabledDesc: 'Re-enable Antigravity Max anytime from Plugins -> Antigravity Max in the right side panel.',
          sshTitle: 'Running in SSH Remote mode',
          sshDesc: 'No local Antigravity desktop debugging interface is available on the remote SSH host. Install Antigravity Max on your local desktop to automatically enhance SSH windows and sync remote session telemetry over OpenSSH.',
          relaunch: 'Restart to Enable',
          relaunching: 'Restarting Antigravity…',
          relaunchSent: 'Relaunch triggered. Closing and reopening Antigravity, please wait…',
          relaunchTimeout: 'Relaunch timed out. Please quit Antigravity completely (including system tray) and reopen from your shortcut, or run the command below.',
          relaunchFailed: 'Automatic restart failed. Please quit Antigravity completely and reopen it manually, or run the command below.',
          macDockHint: 'macOS tip: Drag this launcher onto your Dock to replace the original Antigravity icon (original icon applied automatically) so future launches work out of the box:',
          copyCmd: 'Copy launch command',
          copiedCmd: 'Copied',
          copyDiag: 'Copy diagnostic',
          copiedDiag: 'Diagnostic copied',
          copyFailed: 'Copy failed. Copy the selected text manually.',
          checkUpdate: 'Check for plugin updates',
          checkingUpdate: 'Checking for updates…',
          installUpdate: ver => ver ? ('Install v' + ver) : 'Install update',
          updating: 'Updating…',
          openDownload: 'Open download page',
          upToDate: 'Up to date',
          upToDateCompat: 'Already on the latest release (if Antigravity just updated, check again once a compatibility release is published).',
          available: ver => 'Version v' + ver + ' is available. Click below to verify and install.',
          checkFailed: 'Update check failed. Check your network and try again.',
          rateLimited: 'Too many checks. Try again later.',
          noRelease: 'No published release found.',
          progress: {
            preparing: 'Preparing update…',
            downloading: 'Downloading package…',
            verifying: 'Verifying SHA-256…',
            installing: 'Installing and restarting runtime…',
            completed: 'Update completed. Reattaching to Antigravity…',
            'rolled-back': 'Update failed to start. Previous version restored.',
            failed: 'Update failed. Try again later.'
          }
        }
      };

      function authUrl(path) {
        return path + (token ? '?token=' + encodeURIComponent(token) : '');
      }
      function authHeaders(json) {
        const headers = {};
        if (json) headers['Content-Type'] = 'application/json';
        if (token) headers['x-sidecar-token'] = token;
        return headers;
      }
      function isSafeHttps(url) {
        return typeof url === 'string' && /^https:\\/\\//i.test(url);
      }

      function syncPrimaryActions() {
        primaryActions.hidden = btn.hidden && copyBtn.hidden && copyDiagBtn.hidden;
      }

      function showManualCommand() {
        if (!manualCommand) return;
        cmdBox.hidden = false;
        cmdBox.textContent = manualCommand;
        copyBtn.hidden = false;
        copyBtn.textContent = copy[currentLang].copyCmd;
        syncPrimaryActions();
      }

      function renderUpdateControls() {
        const t = copy[currentLang];
        checkBtn.disabled = checkingUpdate || installingUpdate;
        checkBtn.textContent = checkingUpdate ? t.checkingUpdate : t.checkUpdate;
        if (availableUpdate && availableUpdate.status === 'available' && availableUpdate.canInstall) {
          installBtn.hidden = false;
          installBtn.disabled = installingUpdate || checkingUpdate;
          installBtn.textContent = installingUpdate ? t.updating : t.installUpdate(availableUpdate.version);
        } else {
          installBtn.hidden = true;
        }
        if (availableUpdate && availableUpdate.status === 'available' && isSafeHttps(availableUpdate.releaseUrl)) {
          downloadLink.hidden = false;
          downloadLink.href = availableUpdate.releaseUrl;
          downloadLink.textContent = t.openDownload;
        } else {
          downloadLink.hidden = true;
        }
        if (availableUpdate && availableUpdate.status === 'available' && availableUpdate.notes) {
          updateNotes.hidden = false;
          updateNotes.textContent = availableUpdate.notes;
        } else {
          updateNotes.hidden = true;
        }
      }

      function applyUpdateProgress(st) {
        if (!st || !st.status || st.status === 'idle') {
          installingUpdate = false;
          if (updatePollTimer) {
            clearInterval(updatePollTimer);
            updatePollTimer = null;
          }
          renderUpdateControls();
          return;
        }
        const t = copy[currentLang];
        const msg = t.progress[st.status];
        if (msg) {
          updateFeedback.hidden = false;
          updateFeedback.textContent = msg;
        }
        const active = ['preparing', 'downloading', 'verifying', 'installing'].includes(st.status);
        installingUpdate = active;
        if (!active && updatePollTimer) {
          clearInterval(updatePollTimer);
          updatePollTimer = null;
        }
        renderUpdateControls();
      }

      async function checkUpdates() {
        if (checkingUpdate || installingUpdate) return;
        checkingUpdate = true;
        renderUpdateControls();
        const t = copy[currentLang];
        try {
          const res = await fetch(authUrl('/api/update/check'), { method: 'POST', headers: authHeaders(true), body: '{}' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'failed');
          availableUpdate = data;
          updateFeedback.hidden = false;
          if (data.status === 'available') updateFeedback.textContent = t.available(data.version || '');
          else if (data.status === 'current') updateFeedback.textContent = lastCompatError ? t.upToDateCompat : t.upToDate;
          else if (data.status === 'rate-limited') updateFeedback.textContent = t.rateLimited;
          else if (data.status === 'no-release') updateFeedback.textContent = t.noRelease;
          else updateFeedback.textContent = t.checkFailed;
        } catch {
          availableUpdate = null;
          updateFeedback.hidden = false;
          updateFeedback.textContent = t.checkFailed;
        } finally {
          checkingUpdate = false;
          renderUpdateControls();
        }
      }

      async function installUpdate() {
        if (installingUpdate || checkingUpdate || !availableUpdate?.canInstall) return;
        installingUpdate = true;
        const t = copy[currentLang];
        updateFeedback.hidden = false;
        updateFeedback.textContent = t.progress.preparing;
        renderUpdateControls();
        try {
          const res = await fetch(authUrl('/api/update/install'), {
            method: 'POST',
            headers: authHeaders(true),
            body: JSON.stringify({ version: availableUpdate.version })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'failed');
          applyUpdateProgress(data);
          if (installingUpdate) {
            clearInterval(updatePollTimer);
            updatePollTimer = setInterval(async () => {
              try {
                const sr = await fetch(authUrl('/api/update/status'), { headers: authHeaders(false) });
                if (sr.ok) applyUpdateProgress(await sr.json());
              } catch {}
            }, 900);
          }
        } catch (err) {
          installingUpdate = false;
          if (updatePollTimer) {
            clearInterval(updatePollTimer);
            updatePollTimer = null;
          }
          updateFeedback.hidden = false;
          updateFeedback.textContent = err && err.message && err.message !== 'failed' ? err.message : t.progress.failed;
          renderUpdateControls();
        }
      }

      function applyStatus(data) {
        currentLang = ['zh-CN', 'zh-TW', 'en'].includes(data.language) ? data.language : 'zh-CN';
        document.documentElement.lang = currentLang;
        if (typeof data.manualCommand === 'string') manualCommand = data.manualCommand;
        lastCompatError = typeof data.compatibilityError === 'string' ? data.compatibilityError : '';
        lastClientVersion = typeof data.clientVersion === 'string' ? data.clientVersion : '';
        const t = copy[currentLang];
        const healthy = Boolean(data.healthy);
        const enabled = data.enabled !== false;
        const isCompatFail = enabled && !healthy && Boolean(lastCompatError);
        const portReachable = data.portReachable ?? (healthy || Boolean(data.connected) || isCompatFail);
        const matched = Number(data.matchedTargets) || 0;
        const mounted = Number(data.mountedCount) || 0;
        const partial = mounted > 0 && mounted < matched;
        const waitingForWindow = portReachable && data.matchedTargets === 0;
        const firstError = typeof data.firstError === 'string' ? data.firstError : '';
        dot.dataset.healthy = String(healthy && !partial && portReachable);
        dot.dataset.state = isCompatFail ? 'incompatible' : (dot.dataset.healthy === 'true' ? 'healthy' : 'warning');

        const isMacMissingPort = data.platform === 'darwin' && enabled && !portReachable && data.mode !== 'ssh-remote';
        if (isMacMissingPort) {
          const launcherPath = typeof data.macLauncherApp === 'string' && data.macLauncherApp ? data.macLauncherApp : '~/Applications/Antigravity (Antigravity Max).app';
          macDockHint.hidden = false;
          macDockHint.textContent = t.macDockHint + ' ' + launcherPath;
        } else {
          macDockHint.hidden = true;
        }

        if (!enabled) {
          title.textContent = t.disabledTitle;
          desc.textContent = t.disabledDesc;
          compatBox.hidden = true;
          copyDiagBtn.hidden = true;
          btn.hidden = true;
          copyBtn.hidden = true;
          cmdBox.hidden = true;
          updateBox.hidden = false;
        } else if (data.mode === 'ssh-remote') {
          title.textContent = t.sshTitle;
          desc.textContent = t.sshDesc;
          compatBox.hidden = true;
          copyDiagBtn.hidden = true;
          btn.hidden = true;
          copyBtn.hidden = true;
          cmdBox.hidden = true;
          feedback.hidden = true;
          updateBox.hidden = true;
        } else if (partial || waitingForWindow || (portReachable && !healthy && !isCompatFail)) {
          title.textContent = partial ? t.partialTitle : waitingForWindow ? t.waitingTitle : t.mountingTitle;
          desc.textContent = waitingForWindow ? t.waitingDesc : t.mountingDesc;
          lastCompatError = [partial ? t.mountedWindows + ' ' + mounted + '/' + matched : '', firstError].filter(Boolean).join('\\n');
          compatBox.hidden = !lastCompatError;
          compatBox.textContent = lastCompatError;
          copyDiagBtn.hidden = !lastCompatError;
          copyDiagBtn.textContent = t.copyDiag;
          btn.hidden = true;
          copyBtn.hidden = true;
          cmdBox.hidden = true;
          feedback.hidden = true;
          updateBox.hidden = false;
        } else if (healthy && portReachable) {
          title.textContent = t.activeTitle;
          desc.textContent = t.activeDesc;
          compatBox.hidden = true;
          copyDiagBtn.hidden = true;
          btn.hidden = true;
          copyBtn.hidden = true;
          cmdBox.hidden = true;
          feedback.hidden = true;
          updateBox.hidden = false;
        } else if (isCompatFail && portReachable) {
          title.textContent = t.compatTitle(lastClientVersion);
          desc.textContent = t.compatDesc;
          compatBox.hidden = false;
          compatBox.textContent = lastCompatError;
          copyDiagBtn.hidden = false;
          copyDiagBtn.textContent = t.copyDiag;
          btn.hidden = true;
          copyBtn.hidden = true;
          cmdBox.hidden = true;
          feedback.hidden = true;
          updateBox.hidden = false;
          if (!autoCheckedCompat) {
            autoCheckedCompat = true;
            void checkUpdates();
          }
        } else {
          title.textContent = t.upgradeTitle;
          desc.textContent = t.upgradeDesc;
          compatBox.hidden = true;
          copyDiagBtn.hidden = true;
          btn.hidden = false;
          if (!busy) btn.textContent = t.relaunch;
          if (manualCommand && !copyBtn.hidden) copyBtn.textContent = t.copyCmd;
          updateBox.hidden = false;
        }
        if (copySource?.hidden) {
          copyFallback.hidden = true;
          copyFeedback.hidden = true;
          copySource = null;
        }
        if (data.update && data.update.status && (data.update.status !== 'idle' || installingUpdate || updatePollTimer)) applyUpdateProgress(data.update);
        syncPrimaryActions();
        renderUpdateControls();
      }

      async function poll() {
        try {
          const res = await fetch(authUrl('/api/status'), { headers: authHeaders(false) });
          if (res.ok) applyStatus(await res.json());
        } catch {
        } finally {
          setTimeout(poll, 3000);
        }
      }

      async function copyText(text, source, successKey) {
        if (!text) return;
        clearTimeout(copyTimer);
        copySource = source;
        copyFallback.hidden = true;
        copyFeedback.hidden = true;
        try {
          await navigator.clipboard.writeText(text);
          copyFeedback.textContent = copy[currentLang][successKey];
          copyTimer = setTimeout(() => { copyFeedback.hidden = true; }, 1600);
        } catch {
          copyFeedback.textContent = copy[currentLang].copyFailed;
          copyFallback.value = text;
          copyFallback.setAttribute('aria-label', source.textContent);
          copyFallback.hidden = false;
          copyFallback.focus();
          copyFallback.select();
        }
        copyFeedback.hidden = false;
      }

      copyBtn.addEventListener('click', () => copyText(manualCommand, copyBtn, 'copiedCmd'));

      copyDiagBtn.addEventListener('click', () => {
        if (!lastCompatError) return;
        const text = 'Antigravity Max ' + ${safeInlineJson(version)} + (lastClientVersion ? ' | Antigravity ' + lastClientVersion : '') + '\\n' + lastCompatError;
        return copyText(text, copyDiagBtn, 'copiedDiag');
      });

      checkBtn.addEventListener('click', () => { void checkUpdates(); });
      installBtn.addEventListener('click', () => { void installUpdate(); });

      btn.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        const t = copy[currentLang];
        btn.disabled = true;
        btn.textContent = t.relaunching;
        feedback.hidden = false;
        feedback.textContent = t.relaunchSent;
        clearTimeout(relaunchTimer);
        relaunchTimer = setTimeout(() => {
          busy = false;
          btn.disabled = false;
          btn.textContent = copy[currentLang].relaunch;
          feedback.textContent = copy[currentLang].relaunchTimeout;
          showManualCommand();
        }, 15000);
        try {
          const res = await fetch(authUrl('/api/relaunch'), { method: 'POST', headers: authHeaders(true), body: '{}' });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok || payload.scheduled === false) throw new Error(payload.error || 'failed');
        } catch (err) {
          clearTimeout(relaunchTimer);
          busy = false;
          btn.disabled = false;
          btn.textContent = t.relaunch;
          feedback.textContent = err && err.message && err.message !== 'failed' ? t.relaunchFailed + ' (' + err.message + ')' : t.relaunchFailed;
          showManualCommand();
        }
      });

      applyStatus({ healthy: false, enabled: true, language: currentLang });
      void poll();
    })();
  </script>
</body>
</html>`;
}

export function startSidecarWebUi({
  port = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0),
  token = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '',
  version = '',
  getStatus,
  onRelaunch,
  onCheckUpdate,
  onInstallUpdate,
  onUpdateStatus,
  env = process.env
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.resolve(async () => {});
  }
  const preloadJs = findPreloadJs(env);
  const fallbackToken = typeof token === 'string' && token ? '' : randomBytes(24).toString('hex');
  const expectedToken = (typeof token === 'string' && token) || fallbackToken;
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
  if (port === 80) {
    allowedOrigins.add('http://127.0.0.1');
    allowedOrigins.add('http://localhost');
    allowedOrigins.add('http://[::1]');
  }
  const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::([1-9]\d{0,4}))?$/i;
  const PLUGIN_AUTHORITY_RE = /^(?:agy-max--)?inspector(?:-[a-z0-9_-]+)?(?::([1-9]\d{0,4}))?$/i;
  const PLUGIN_ORIGIN_RE = /^plugin:\/\/(?:agy-max--)?inspector(?:-[a-z0-9_-]+)?(?::([1-9]\d{0,4}))?$/i;
  const validPortNumber = raw => raw === undefined || (Number(raw) >= 1 && Number(raw) <= 65535);
  const isAllowedHost = req => {
    const host = String(req.headers.host || '').trim().toLowerCase();
    if (!host) return false;
    const loopMatch = host.match(LOOPBACK_HOST_RE);
    if (loopMatch) return validPortNumber(loopMatch[1]);
    const pluginMatch = host.match(PLUGIN_AUTHORITY_RE);
    if (pluginMatch) return validPortNumber(pluginMatch[1]);
    return false;
  };
  const isAllowedOrigin = req => {
    const fetchSite = req.headers['sec-fetch-site'];
    if (typeof fetchSite === 'string' && fetchSite.trim()) {
      const normalized = fetchSite.trim().toLowerCase();
      if (normalized !== 'same-origin' && normalized !== 'none') return false;
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.trim()) {
      const cleanOrigin = origin.trim().toLowerCase();
      if (PLUGIN_ORIGIN_RE.test(cleanOrigin)) return true;
      const host = String(req.headers.host || '').trim().toLowerCase();
      if (LOOPBACK_HOST_RE.test(host) && cleanOrigin === `http://${host}`) return true;
      return allowedOrigins.has(cleanOrigin);
    }
    return true;
  };
  const authorized = (req, url) => {
    if (url.pathname === '/preload.js') return true;
    if (!expectedToken) return false;
    const rawHeader = req.headers['x-sidecar-token'];
    const headerToken = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const provided = typeof headerToken === 'string' && headerToken ? headerToken : (url.searchParams.get('token') || '');
    return tokensMatch(provided, expectedToken);
  };

  const server = createServer(async (req, res) => {
    try {
      if (!isAllowedHost(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      if (req.method !== 'GET') {
        if (!isAllowedOrigin(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        if (!authorized(req, url)) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
      }
      if (req.method === 'GET' && url.pathname === '/preload.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(preloadJs);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        const current = (await getStatus?.()) || {};
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderAuxPaneHtml({ version, language: current.language || 'zh-CN', fallbackToken }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        if (!authorized(req, url)) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const current = (await getStatus?.()) || { healthy: false, enabled: true, language: 'zh-CN' };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ version, ...nativeMountDiagnostics, ...current }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/update/status') {
        if (!authorized(req, url)) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const status = (await onUpdateStatus?.()) || { status: 'idle' };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(status));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/update/check') {
        const result = (await onCheckUpdate?.()) || { status: 'error' };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/update/install') {
        const body = await readJsonBody(req);
        const result = await onInstallUpdate?.({ version: body?.version });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result || { status: 'preparing' }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/relaunch') {
        const result = await onRelaunch?.();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...result }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (error) {
      if (res.writableEnded) return;
      const status = error?.code === 'ERR_INVALID_URL' ? 400 : 500;
      const message = status === 400 ? 'invalid url' : (error?.message || 'internal error');
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ error: message }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(() => new Promise(done => server.close(() => done())));
    });
  });
}
