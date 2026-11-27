(() => {
  globalThis.__agyCreateSshProjects = function createSshProjects(env) {
    const R = globalThis.React;
    const h = R.createElement;
    const doc = typeof document !== 'undefined' ? document : null;
    const TERMINAL_PANE_KEY = 'agySshTerminal';
    let disposed = false;
    let enabled = true;
    let loading = false;
    let hydrated = false;
    let data = { hosts: [], projects: [], statuses: {}, configHosts: [], capabilities: { skills: [], plugins: [] } };
    const seenNativeIds = new Set();

    let modalState = null; // { mode: 'create'|'edit', project?: obj }
    let transferState = null; // { project: obj, direction: 'upload'|'download' }
    let overlayRoot = null;
    let overlayMount = null;
    const listeners = new Set();
    const emit = () => { for (const fn of listeners) try { fn(); } catch {} };

    const styleEl = doc?.createElement ? doc.createElement('style') : null;
    if (styleEl && doc?.head) {
      styleEl.setAttribute('data-agy-ssh-projects-style', '1');
      styleEl.textContent = `
        .agy-ssh-backdrop{position:fixed;inset:0;z-index:2147482800;background:rgba(0,0,0,.48);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(2px)}
        .agy-ssh-dialog{width:min(560px,96vw);max-height:88vh;display:flex;flex-direction:column;border-radius:14px;border:1px solid var(--border);background:var(--background);color:var(--foreground);box-shadow:0 20px 56px rgba(0,0,0,.32);overflow:hidden;font-size:13px}
        .agy-ssh-dialog-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border);flex-shrink:0}
        .agy-ssh-dialog-title{font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px}
        .agy-ssh-dialog-body{padding:16px 18px;overflow-y:auto;display:flex;flex-direction:column;gap:14px}
        .agy-ssh-dialog-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 18px;border-top:1px solid var(--border);background:color-mix(in srgb,var(--secondary) 45%,var(--background));flex-shrink:0}
        .agy-ssh-section{display:flex;flex-direction:column;gap:8px}
        .agy-ssh-label{font-size:12px;font-weight:500;color:var(--muted-foreground)}
        .agy-ssh-row{display:flex;gap:8px;align-items:center}
        .agy-ssh-input{width:100%;height:34px;padding:0 10px;border-radius:8px;border:1px solid var(--border);background:var(--card,var(--background));color:var(--foreground);font:inherit;font-size:12.5px;outline:none}
        .agy-ssh-input:focus{border-color:var(--primary)}
        .agy-ssh-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--border);background:var(--card,var(--background));color:var(--foreground);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap}
        .agy-ssh-btn:hover:not(:disabled){background:var(--secondary)}
        .agy-ssh-btn:disabled{opacity:.5;cursor:default}
        .agy-ssh-btn-primary{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground)}
        .agy-ssh-btn-primary:hover:not(:disabled){opacity:.92;background:var(--primary)}
        .agy-ssh-btn-danger{color:#ef4444;border-color:color-mix(in srgb,#ef4444 40%,var(--border))}
        .agy-ssh-btn-danger:hover:not(:disabled){background:color-mix(in srgb,#ef4444 10%,var(--background))}
        .agy-ssh-tabs{display:flex;padding:3px;border-radius:9px;background:var(--secondary);gap:3px}
        .agy-ssh-tab{flex:1;height:28px;border:0;border-radius:7px;background:transparent;color:var(--muted-foreground);font:inherit;font-size:12px;font-weight:500;cursor:pointer}
        .agy-ssh-tab[data-active="true"]{background:var(--background);color:var(--foreground);box-shadow:0 1px 3px rgba(0,0,0,.1)}
        .agy-ssh-list{display:flex;flex-direction:column;gap:4px;max-height:170px;overflow-y:auto;border:1px solid var(--border);border-radius:9px;padding:6px;background:color-mix(in srgb,var(--secondary) 28%,var(--background))}
        .agy-ssh-host-card{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--foreground);cursor:pointer;text-align:left;font:inherit;font-size:12.5px}
        .agy-ssh-host-card:hover{background:var(--secondary)}
        .agy-ssh-host-card[data-selected="true"]{border-color:var(--primary);background:color-mix(in srgb,var(--primary) 12%,var(--background))}
        .agy-ssh-pill{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:11px;border:1px solid var(--border);color:var(--muted-foreground);background:var(--secondary)}
        .agy-ssh-dot{width:6px;height:6px;border-radius:999px;display:inline-block;flex-shrink:0}
        .agy-ssh-sidebar-icon{position:relative;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px}
        .agy-ssh-sidebar-dot{position:absolute;right:-2px;bottom:-1px;width:6px;height:6px;border-radius:999px;border:1.25px solid var(--sidebar,var(--background))}
        .agy-ssh-bar{position:fixed;right:18px;bottom:14px;z-index:45;display:inline-flex;align-items:center;gap:8px;padding:5px 10px;border-radius:10px;border:1px solid var(--border);background:color-mix(in srgb,var(--card,var(--background)) 94%,transparent);box-shadow:0 6px 20px rgba(0,0,0,.12);font-size:12px;color:var(--foreground);backdrop-filter:blur(8px)}
        .agy-ssh-bar-btn{border:0;background:transparent;color:var(--muted-foreground);padding:2px 6px;border-radius:6px;cursor:pointer;font:inherit;font-size:11.5px;display:inline-flex;align-items:center;gap:4px}
        .agy-ssh-bar-btn:hover{background:var(--secondary);color:var(--foreground)}
        .agy-ssh-term-root{width:100%;height:100%;display:flex;flex-direction:column;background:var(--background);color:var(--foreground);font-size:12px}
        .agy-ssh-term-head{height:38px;padding:0 10px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:6px;flex-shrink:0}
        .agy-ssh-term-out{flex:1;min-height:0;overflow:auto;margin:0;padding:10px 12px;font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;background:color-mix(in srgb,var(--secondary) 35%,var(--background));color:var(--foreground)}
        .agy-ssh-term-in{display:flex;align-items:center;gap:6px;padding:8px 10px;border-top:1px solid var(--border);flex-shrink:0}
        .agy-ssh-add-item{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border:0;border-top:1px solid var(--border);background:transparent;color:var(--foreground);font:inherit;font-size:13px;cursor:pointer;text-align:left;transition:background 100ms ease}
        .agy-ssh-add-item:hover{background:var(--secondary)}
        .agy-ssh-cap-grid{display:flex;flex-direction:column;gap:4px;max-height:130px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:6px 8px}
        .agy-ssh-check{display:flex;align-items:center;gap:7px;font-size:12px;cursor:pointer;padding:2px 0}
        .agy-ssh-dir-item{display:flex;align-items:center;gap:6px;padding:5px 8px;border:0;border-radius:6px;background:transparent;color:var(--foreground);cursor:pointer;font:inherit;font-size:12px;text-align:left;width:100%}
        .agy-ssh-dir-item:hover{background:var(--secondary)}
      `;
      doc.head.appendChild(styleEl);
    }

    function cloudSshSvg(size = 16) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        className: 'shrink-0',
        'aria-hidden': 'true'
      },
        h('path', { d: 'M6.5 19h11a4.5 4.5 0 0 0 .9-8.91A6 6 0 0 0 6.8 8.3 4 4 0 0 0 6.5 19Z' }),
        h('path', { d: 'M9.2 13.2l2 1.8-2 1.8', strokeWidth: 1.7 }),
        h('path', { d: 'M12.8 16.8h2.5', strokeWidth: 1.7 })
      );
    }

    const CLOUD_SSH_SVG_HTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="shrink-0 text-muted-foreground group-hover/headerbtn:text-secondary-foreground"><path d="M6.5 19h11a4.5 4.5 0 0 0 .9-8.91A6 6 0 0 0 6.8 8.3 4 4 0 0 0 6.5 19Z"/><path d="M9.2 13.2l2 1.8-2 1.8" stroke-width="1.7"/><path d="M12.8 16.8h2.5" stroke-width="1.7"/></svg>';
    const GEAR_SVG_HTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>';

    function statusColor(st) {
      if (st === 'connected') return '#22c55e';
      if (st === 'connecting') return '#f59e0b';
      if (st === 'error') return '#ef4444';
      return 'var(--muted-foreground)';
    }

    function statusLabel(st, uiText) {
      if (st === 'connected') return uiText('已连接', 'Connected');
      if (st === 'connecting') return uiText('连接中...', 'Connecting...');
      if (st === 'error') return uiText('连接异常', 'Error');
      return uiText('未连接', 'Offline');
    }

    function stripAnsi(str = '') {
      return String(str).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
    }

    async function refreshData() {
      if (loading || disposed) return data;
      loading = true;
      try {
        const res = await env.request('sshProject.list');
        if (res?.ok) {
          data = {
            hosts: Array.isArray(res.hosts) ? res.hosts : [],
            projects: Array.isArray(res.projects) ? res.projects : [],
            statuses: res.statuses && typeof res.statuses === 'object' ? res.statuses : {},
            configHosts: Array.isArray(res.configHosts) ? res.configHosts : [],
            capabilities: res.capabilities || { skills: [], plugins: [] }
          };
          hydrated = true;
          syncSidebarIcons();
          reconcileDeletedProjects();
          emit();
        }
      } catch { /* Ignore transient disconnect. */ }
      finally { loading = false; }
      return data;
    }

    function projectByNativeId(nativeId) {
      if (!nativeId) return null;
      return data.projects.find(p => p.nativeProjectId === nativeId || p.id === nativeId) || null;
    }

    function projectByWorkspaceUri(wsUri) {
      if (!wsUri) return null;
      const clean = String(wsUri).replace(/\/+$/, '').toLowerCase();
      return data.projects.find(p => {
        if (!p.workspaceUri) return false;
        const pUri = String(p.workspaceUri).replace(/\/+$/, '').toLowerCase();
        return clean === pUri || clean.startsWith(`${pUri}/`);
      }) || null;
    }

    function activeSshProject() {
      const cid = env.currentId?.() || '';
      if (cid) {
        const ws = env.adapter?.workspaceUri?.(cid) || '';
        const byWs = projectByWorkspaceUri(ws);
        if (byWs) return byWs;
        const dir = env.adapter?.conversationDirectory?.();
        const rec = dir?.byId?.[cid];
        if (rec?.projectId) {
          const byPid = projectByNativeId(rec.projectId);
          if (byPid) return byPid;
        }
      }
      if (typeof location !== 'undefined' && location.search) {
        const pid = new URLSearchParams(location.search).get('project')?.trim() || '';
        if (pid) {
          const byPid = projectByNativeId(pid);
          if (byPid) return byPid;
        }
      }
      return null;
    }

    function reconcileDeletedProjects() {
      const nativeList = env.adapter?.sidebarProjects?.();
      if (!Array.isArray(nativeList) || !nativeList.length) return;
      const nativeIds = new Set(nativeList.map(p => p?.id).filter(Boolean));
      for (const proj of data.projects) {
        const nid = proj.nativeProjectId || proj.id;
        if (nativeIds.has(nid)) {
          seenNativeIds.add(nid);
        } else if (seenNativeIds.has(nid)) {
          // User removed the project from Antigravity natively: clean local binding only, preserve host & remote files.
          seenNativeIds.delete(nid);
          void env.request('sshProject.delete', { projectId: proj.id }).then(() => refreshData()).catch(() => {});
        }
      }
    }

    function closeNativeCreateProjectModal() {
      if (!doc) return;
      const step = doc.querySelector('[data-testid="project-folder-selection-step"]');
      if (!step) return;
      const dialog = step.closest('[role="dialog"], .fixed');
      const closeBtn = dialog?.querySelector?.('button[aria-label="Close"], button[aria-label="关闭"], button[data-testid*="close"]');
      if (closeBtn) {
        closeBtn.click();
      } else {
        doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
    }

    function injectAddResourceMenuItem() {
      if (!doc || !enabled) return;
      const step = doc.querySelector('[data-testid="project-folder-selection-step"]');
      if (!step) return;
      const uiText = env.uiText;
      const candidates = [...doc.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], div.rounded-xl, div.rounded-lg')];
      for (const box of candidates) {
        if (!box.isConnected || box.closest('[data-testid="agy-ssh-project-modal"]')) continue;
        if (box.querySelector('[data-testid="agy-ssh-add-resource-item"]')) continue;
        const text = box.textContent || '';
        const hasUpload = /Upload Files|上传文件/i.test(text);
        const hasProvider = /Google Drive|GitHub/i.test(text);
        if (!hasUpload || !hasProvider) continue;
        // Pick the tightest menu container (not document.body or giant wrapper)
        if (box.querySelectorAll('button, [role="menuitem"]').length > 12) continue;
        const sampleItem = [...box.querySelectorAll('button, [role="menuitem"]')].find(el => /GitHub|Google Drive/i.test(el.textContent || ''));
        const hostList = sampleItem?.parentElement || box;
        if (hostList.querySelector('[data-testid="agy-ssh-add-resource-item"]')) continue;

        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-testid', 'agy-ssh-add-resource-item');
        btn.setAttribute('data-agy-powertools-root', 'ssh-add-resource');
        btn.className = 'agy-ssh-add-item';
        btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px">${CLOUD_SSH_SVG_HTML}<span>${uiText('SSH 服务器', 'SSH Server')}</span></span><span style="opacity:.6;font-size:13px">›</span>`;
        btn.addEventListener('click', ev => {
          ev.preventDefault();
          ev.stopPropagation();
          void openCreateModal();
        });
        hostList.appendChild(btn);
        break;
      }
    }

    function syncSidebarIcons() {
      if (!doc) return;
      const headers = doc.querySelectorAll('[data-testid="project-header"]');
      const nativeProjects = env.adapter?.sidebarProjects?.() || [];
      const nativeFolderMap = new Map(nativeProjects.map(p => [p.id, Array.isArray(p.folderUris) ? p.folderUris : []]));

      for (const hdr of headers) {
        const pid = env.adapter?.projectIdFromElement?.(hdr) || '';
        let proj = projectByNativeId(pid);
        if (!proj && pid) {
          const uris = nativeFolderMap.get(pid) || [];
          for (const u of uris) {
            proj = projectByWorkspaceUri(u);
            if (proj) break;
          }
        }
        const iconSlot = hdr.querySelector('[data-testid="project-header-icon"]');
        const actionsSlot = hdr.querySelector('[data-testid="project-header-actions"]');

        if (!enabled || !proj) {
          const custom = iconSlot?.querySelector('[data-agy-ssh-cloud-icon]');
          if (custom) {
            custom.remove();
            for (const ch of [...(iconSlot.children || [])]) ch.style.display = '';
          }
          actionsSlot?.querySelector('[data-testid="agy-ssh-project-settings-btn"]')?.remove();
          continue;
        }

        const st = data.statuses?.[proj.hostId]?.status || 'offline';
        const dotColor = statusColor(st);
        if (iconSlot) {
          const nativeInner = [...iconSlot.children].find(ch => !ch.hasAttribute('data-agy-ssh-cloud-icon'));
          if (nativeInner) nativeInner.style.display = 'none';
          let badge = iconSlot.querySelector('[data-agy-ssh-cloud-icon]');
          if (!badge) {
            badge = doc.createElement('span');
            badge.setAttribute('data-agy-ssh-cloud-icon', proj.id);
            badge.setAttribute('data-agy-powertools-root', 'ssh-sidebar-icon');
            badge.className = 'agy-ssh-sidebar-icon';
            badge.innerHTML = `${CLOUD_SSH_SVG_HTML}<span class="agy-ssh-sidebar-dot"></span>`;
            iconSlot.appendChild(badge);
          }
          badge.title = `${proj.host?.name || proj.hostId}${proj.remoteDir ? ` | ${proj.remoteDir}` : ''} (${statusLabel(st, env.uiText)})`;
          const dot = badge.querySelector('.agy-ssh-sidebar-dot');
          if (dot) dot.style.background = dotColor;
        }

        if (actionsSlot && !actionsSlot.querySelector('[data-testid="agy-ssh-project-settings-btn"]')) {
          const gear = doc.createElement('button');
          gear.type = 'button';
          gear.setAttribute('data-testid', 'agy-ssh-project-settings-btn');
          gear.setAttribute('data-agy-powertools-root', 'ssh-sidebar-gear');
          gear.title = env.uiText('SSH 项目设置 / 换绑主机', 'SSH Project Settings');
          gear.className = 'inline-flex items-center justify-center w-6 h-6 rounded hover:bg-secondary text-muted-foreground hover:text-foreground cursor-pointer';
          gear.style.border = '0';
          gear.style.background = 'transparent';
          gear.innerHTML = GEAR_SVG_HTML;
          gear.addEventListener('click', ev => {
            ev.preventDefault();
            ev.stopPropagation();
            void openEditModal(proj);
          });
          actionsSlot.prepend(gear);
        }
      }
    }

    async function openCreateModal() {
      await refreshData();
      modalState = { mode: 'create', project: null };
      ensureOverlay();
      emit();
    }

    async function openEditModal(project) {
      await refreshData();
      const latest = data.projects.find(p => p.id === project.id) || project;
      modalState = { mode: 'edit', project: latest };
      ensureOverlay();
      emit();
    }

    function openTransferModal(project, direction = 'upload') {
      transferState = { project, direction };
      ensureOverlay();
      emit();
    }

    function SshProjectModal({ mode, project, onClose }) {
      const uiText = env.uiText;
      const isEdit = mode === 'edit' && Boolean(project);
      const initialHost = isEdit ? (data.hosts.find(x => x.id === project.hostId) || null) : (data.hosts[0] || null);
      const [hostTab, setHostTab] = R.useState(initialHost || data.configHosts.length ? 'existing' : 'new');
      const [selectedHostId, setSelectedHostId] = R.useState(initialHost?.id || '');
      const [selectedConfigAlias, setSelectedConfigAlias] = R.useState('');

      const [pasteRaw, setPasteRaw] = R.useState('');
      const [editingExistingHost, setEditingExistingHost] = R.useState(false);
      const [alias, setAlias] = R.useState(initialHost?.name || '');
      const [hostAddr, setHostAddr] = R.useState(initialHost?.host || '');
      const [port, setPort] = R.useState(String(initialHost?.port || 22));
      const [user, setUser] = R.useState(initialHost?.user || 'root');
      const [proxyJump, setProxyJump] = R.useState(initialHost?.proxyJump || '');
      const [authType, setAuthType] = R.useState(initialHost?.authType || 'key');
      const [identityFile, setIdentityFile] = R.useState(initialHost?.identityFile || '');
      const [password, setPassword] = R.useState('');
      const [savePassword, setSavePassword] = R.useState(true);
      const [installKeyOnCreate, setInstallKeyOnCreate] = R.useState(true);

      const [remoteDir, setRemoteDir] = R.useState(isEdit ? (project.remoteDir || '') : '');
      const [projectName, setProjectName] = R.useState(isEdit ? (project.name || '') : '');
      const [showDirBrowser, setShowDirBrowser] = R.useState(false);
      const [browsePath, setBrowsePath] = R.useState('~');
      const [browseEntries, setBrowseEntries] = R.useState([]);
      const [browsing, setBrowsing] = R.useState(false);

      const [capExpanded, setCapExpanded] = R.useState(false);
      const [capMode, setCapMode] = R.useState(project?.capabilityScope?.mode || 'all');
      const [capQuery, setCapQuery] = R.useState('');
      const [allowedSkills, setAllowedSkills] = R.useState(() => new Set(project?.capabilityScope?.allowedSkills || []));
      const [allowedPlugins, setAllowedPlugins] = R.useState(() => new Set(project?.capabilityScope?.allowedPlugins || []));

      const [testing, setTesting] = R.useState(false);
      const [testResult, setTestResult] = R.useState(null);
      const [submitting, setSubmitting] = R.useState(false);
      const [errorMsg, setErrorMsg] = R.useState('');

      const handlePasteSsh = val => {
        setPasteRaw(val);
        if (typeof parseSshCommand !== 'function') return;
        const parsed = parseSshCommand(val);
        if (parsed?.valid) {
          if (parsed.host) setHostAddr(parsed.host);
          if (parsed.port) setPort(String(parsed.port));
          if (parsed.user) setUser(parsed.user);
          if (parsed.identityFile) setIdentityFile(parsed.identityFile);
          if (parsed.proxyJump) setProxyJump(parsed.proxyJump);
          if (parsed.suggestedAlias) setAlias(parsed.suggestedAlias);
          setErrorMsg('');
        }
      };

      const buildHostTestPayload = () => {
        if (hostTab === 'existing' && !editingExistingHost) {
          if (selectedHostId) return { hostId: selectedHostId, ...(password ? { password } : {}) };
          if (selectedConfigAlias) {
            const cfg = data.configHosts.find(c => c.alias === selectedConfigAlias);
            return {
              configAlias: selectedConfigAlias,
              host: cfg?.host || selectedConfigAlias,
              user: cfg?.user || '',
              port: cfg?.port || 22,
              identityFile: cfg?.identityFile || '',
              proxyJump: cfg?.proxyJump || '',
              authType: 'config'
            };
          }
          throw new Error(uiText('请先选择一台 SSH 主机', 'Please select an SSH host first'));
        }
        return {
          ...(editingExistingHost && selectedHostId ? { id: selectedHostId } : {}),
          name: alias.trim(),
          host: hostAddr.trim(),
          port: Number(port) || 22,
          user: user.trim(),
          proxyJump: proxyJump.trim(),
          authType,
          identityFile: identityFile.trim(),
          password: password || ''
        };
      };

      const runTest = async () => {
        setTesting(true);
        setErrorMsg('');
        setTestResult(null);
        try {
          const payload = buildHostTestPayload();
          const res = await env.request('sshProject.testHost', payload);
          setTestResult(res);
          void refreshData();
        } catch (err) {
          setErrorMsg(err?.message || uiText('连接测试失败', 'Connection test failed'));
        } finally {
          setTesting(false);
        }
      };

      const loadRemoteDir = async targetPath => {
        setBrowsing(true);
        setErrorMsg('');
        try {
          const payload = buildHostTestPayload();
          const res = await env.request('sshProject.browseDir', { ...payload, path: targetPath || '~' });
          setBrowsePath(res.dirPath || targetPath || '~');
          setBrowseEntries((res.entries || []).filter(e => e.isDirectory));
          setShowDirBrowser(true);
        } catch (err) {
          setErrorMsg(err?.message || uiText('浏览远端目录失败', 'Failed to browse remote folder'));
        } finally {
          setBrowsing(false);
        }
      };

      const handleInstallKey = async () => {
        if (!selectedHostId) return;
        setTesting(true);
        setErrorMsg('');
        try {
          const res = await env.request('sshProject.installKey', { hostId: selectedHostId, password });
          await refreshData();
          setAuthType('key');
          setIdentityFile(res.privateKeyPath || '');
          env.notify?.({ title: uiText('免密公钥已配置', 'SSH key installed'), message: res.publicKeyPath || '' });
        } catch (err) {
          setErrorMsg(err?.message || uiText('配置免密公钥失败', 'Failed to install SSH key'));
        } finally {
          setTesting(false);
        }
      };

      const handleSubmit = async () => {
        setSubmitting(true);
        setErrorMsg('');
        try {
          let finalHostId = selectedHostId;
          if (hostTab === 'existing' && !editingExistingHost) {
            if (!finalHostId && selectedConfigAlias) {
              const cfg = data.configHosts.find(c => c.alias === selectedConfigAlias);
              const saved = await env.request('sshProject.saveHost', {
                name: selectedConfigAlias,
                configAlias: selectedConfigAlias,
                host: cfg?.host || selectedConfigAlias,
                user: cfg?.user || '',
                port: cfg?.port || 22,
                identityFile: cfg?.identityFile || '',
                proxyJump: cfg?.proxyJump || '',
                authType: 'config'
              });
              finalHostId = saved.host.id;
            }
            if (!finalHostId) throw new Error(uiText('请选择或新建一台 SSH 主机', 'Please select or create an SSH host'));
          } else {
            if (!hostAddr.trim()) throw new Error(uiText('请填写服务器地址', 'Host address is required'));
            const saved = await env.request('sshProject.saveHost', {
              ...(editingExistingHost && selectedHostId ? { id: selectedHostId } : {}),
              name: alias.trim(),
              host: hostAddr.trim(),
              port: Number(port) || 22,
              user: user.trim(),
              proxyJump: proxyJump.trim(),
              authType,
              identityFile: identityFile.trim(),
              ...(authType === 'password' && password ? { password, savePassword } : {})
            });
            finalHostId = saved.host.id;
            if (authType === 'password' && password && installKeyOnCreate) {
              try {
                await env.request('sshProject.installKey', { hostId: finalHostId, password });
              } catch { /* Non-fatal if password login works directly. */ }
            }
          }

          const capabilityScope = {
            mode: capMode,
            allowedSkills: [...allowedSkills],
            allowedPlugins: [...allowedPlugins]
          };

          if (isEdit) {
            await env.request('sshProject.update', {
              projectId: project.id,
              name: projectName.trim() || project.name,
              hostId: finalHostId,
              remoteDir: remoteDir.trim(),
              capabilityScope
            });
            await refreshData();
            env.notify?.({ title: uiText('SSH 项目已更新', 'SSH project updated'), message: uiText('历史聊天记录已完整保留', 'Chat history preserved') });
            onClose();
            return;
          }

          const created = await env.request('sshProject.create', {
            name: projectName.trim(),
            hostId: finalHostId,
            remoteDir: remoteDir.trim(),
            capabilityScope
          });
          const proj = created.project;
          await env.adapter.createNativeProject({
            id: proj.id,
            name: proj.name,
            folderUri: proj.workspaceUri
          });
          closeNativeCreateProjectModal();
          await refreshData();
          env.notify?.({
            title: uiText(`已创建 SSH 项目「${proj.name}」`, `Created SSH project "${proj.name}"`),
            message: `${proj.host?.name || finalHostId}${proj.remoteDir ? ` | ${proj.remoteDir}` : ''}`
          });
          onClose();
        } catch (err) {
          setErrorMsg(err?.message || uiText('操作失败', 'Operation failed'));
        } finally {
          setSubmitting(false);
        }
      };

      const handleDeleteBinding = async () => {
        if (!isEdit) return;
        setSubmitting(true);
        try {
          await env.request('sshProject.delete', { projectId: project.id });
          await refreshData();
          env.notify?.({ title: uiText('已移除本地 SSH 项目绑定', 'SSH project binding removed'), message: uiText('远程服务器文件与 SSH 主机均已保留', 'Remote files and SSH host preserved') });
          onClose();
        } catch (err) {
          setErrorMsg(err?.message || uiText('移除失败', 'Failed to remove'));
        } finally {
          setSubmitting(false);
        }
      };

      const toggleSet = (setObj, setter, id) => {
        const next = new Set(setObj);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setter(next);
      };

      const parentBrowsePath = () => {
        if (!browsePath || browsePath === '/' || browsePath === '~') return '/';
        const parts = browsePath.replace(/\/+$/, '').split('/');
        parts.pop();
        return parts.join('/') || '/';
      };

      return h('div', {
        className: 'agy-ssh-backdrop',
        'data-testid': 'agy-ssh-project-modal',
        'data-agy-powertools-root': 'ssh-project-modal',
        onClick: ev => { if (ev.target === ev.currentTarget) onClose(); }
      },
        h('div', { className: 'agy-ssh-dialog', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'agy-ssh-dialog-head' },
            h('div', { className: 'agy-ssh-dialog-title' },
              cloudSshSvg(18),
              h('span', null, isEdit ? uiText('SSH 项目设置', 'SSH Project Settings') : uiText('新建 SSH 远程项目', 'New SSH Remote Project'))
            ),
            h('button', { type: 'button', className: 'agy-ssh-btn', style: { width: 28, height: 28, padding: 0 }, onClick: onClose }, '✕')
          ),
          h('div', { className: 'agy-ssh-dialog-body' },
            // 1. Host Section
            h('div', { className: 'agy-ssh-section' },
              h('div', { className: 'agy-ssh-row', style: { justifyContent: 'space-between' } },
                h('span', { className: 'agy-ssh-label' }, uiText('1. SSH 主机（可被多个项目复用）', '1. SSH Host (reusable across projects)')),
                isEdit && selectedHostId && hostTab === 'existing' && h('button', {
                  type: 'button',
                  className: 'agy-ssh-btn',
                  style: { height: 24, fontSize: 11.5, padding: '0 8px' },
                  onClick: () => {
                    const cur = data.hosts.find(x => x.id === selectedHostId);
                    if (cur) {
                      setAlias(cur.name || '');
                      setHostAddr(cur.host || '');
                      setPort(String(cur.port || 22));
                      setUser(cur.user || '');
                      setProxyJump(cur.proxyJump || '');
                      setAuthType(cur.authType || 'key');
                      setIdentityFile(cur.identityFile || '');
                    }
                    setEditingExistingHost(!editingExistingHost);
                  }
                }, editingExistingHost ? uiText('返回列表', 'Back to list') : uiText('修改主机地址 / 端口', 'Edit host IP / port'))
              ),
              h('div', { className: 'agy-ssh-tabs' },
                h('button', { type: 'button', className: 'agy-ssh-tab', 'data-active': String(hostTab === 'existing'), onClick: () => { setHostTab('existing'); setEditingExistingHost(false); } }, uiText('已有主机 / ~/.ssh/config', 'Saved / ~/.ssh/config')),
                h('button', { type: 'button', className: 'agy-ssh-tab', 'data-active': String(hostTab === 'new'), onClick: () => { setHostTab('new'); setEditingExistingHost(false); } }, uiText('新建 / 粘贴 SSH 命令', 'New / Paste ssh cmd'))
              ),
              hostTab === 'existing' && !editingExistingHost
                ? h('div', { className: 'agy-ssh-list' },
                    data.hosts.map(item => h('button', {
                      key: item.id,
                      type: 'button',
                      className: 'agy-ssh-host-card',
                      'data-selected': String(selectedHostId === item.id),
                      onClick: () => { setSelectedHostId(item.id); setSelectedConfigAlias(''); }
                    },
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
                        h('span', { className: 'agy-ssh-dot', style: { background: statusColor(data.statuses?.[item.id]?.status) } }),
                        h('span', { style: { fontWeight: 500 } }, item.name),
                        h('span', { style: { color: 'var(--muted-foreground)', fontSize: 11.5 } }, `${item.user ? `${item.user}@` : ''}${item.host}:${item.port || 22}`)
                      ),
                      h('span', { className: 'agy-ssh-pill' }, item.authType === 'password' ? uiText('密码', 'Pass') : uiText('密钥', 'Key'))
                    )),
                    data.configHosts.filter(c => !data.hosts.some(s => s.configAlias === c.alias)).map(cfg => h('button', {
                      key: `cfg:${cfg.alias}`,
                      type: 'button',
                      className: 'agy-ssh-host-card',
                      'data-selected': String(!selectedHostId && selectedConfigAlias === cfg.alias),
                      onClick: () => { setSelectedHostId(''); setSelectedConfigAlias(cfg.alias); }
                    },
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                        h('span', { style: { fontWeight: 500 } }, cfg.alias),
                        h('span', { style: { color: 'var(--muted-foreground)', fontSize: 11.5 } }, `${cfg.user ? `${cfg.user}@` : ''}${cfg.host}:${cfg.port || 22}`)
                      ),
                      h('span', { className: 'agy-ssh-pill' }, '~/.ssh/config')
                    )),
                    !data.hosts.length && !data.configHosts.length && h('div', { style: { padding: 10, color: 'var(--muted-foreground)', fontSize: 12 } }, uiText('暂无已保存主机，请切换到「新建 / 粘贴 SSH 命令」。', 'No hosts yet. Switch to New / Paste ssh cmd.'))
                  )
                : h('div', { className: 'agy-ssh-section' },
                    !editingExistingHost && h('input', {
                      className: 'agy-ssh-input',
                      value: pasteRaw,
                      onChange: e => handlePasteSsh(e.target.value),
                      placeholder: uiText('可直接粘贴整条命令，如 ssh -p 11430 root@connect.westb.seetacloud.com', 'Paste full command: ssh -p 22 root@host')
                    }),
                    h('div', { className: 'agy-ssh-row' },
                      h('input', { className: 'agy-ssh-input', style: { flex: 2 }, value: hostAddr, onChange: e => setHostAddr(e.target.value), placeholder: uiText('服务器 IP 或域名', 'Host / IP') }),
                      h('input', { className: 'agy-ssh-input', style: { flex: 0.7 }, value: port, onChange: e => setPort(e.target.value), placeholder: '22' }),
                      h('input', { className: 'agy-ssh-input', style: { flex: 1 }, value: user, onChange: e => setUser(e.target.value), placeholder: uiText('用户名 (如 root)', 'User') })
                    ),
                    h('div', { className: 'agy-ssh-row' },
                      h('input', { className: 'agy-ssh-input', style: { flex: 1 }, value: alias, onChange: e => setAlias(e.target.value), placeholder: uiText('主机名称（选填）', 'Host name (optional)') }),
                      h('input', { className: 'agy-ssh-input', style: { flex: 1 }, value: proxyJump, onChange: e => setProxyJump(e.target.value), placeholder: uiText('跳板机 ProxyJump（选填）', 'ProxyJump (optional)') })
                    ),
                    h('div', { className: 'agy-ssh-row' },
                      h('button', { type: 'button', className: 'agy-ssh-btn', style: { flex: 1, borderColor: authType === 'key' ? 'var(--primary)' : undefined }, onClick: () => setAuthType('key') }, uiText('SSH 密钥（免密）', 'SSH Key')),
                      h('button', { type: 'button', className: 'agy-ssh-btn', style: { flex: 1, borderColor: authType === 'password' ? 'var(--primary)' : undefined }, onClick: () => setAuthType('password') }, uiText('密码登录', 'Password'))
                    ),
                    authType === 'key'
                      ? h('input', { className: 'agy-ssh-input', value: identityFile, onChange: e => setIdentityFile(e.target.value), placeholder: uiText('私钥路径（留空默认 ~/.ssh/id_ed25519 或 ssh-agent）', 'IdentityFile (leave blank for default key)') })
                      : h('div', { className: 'agy-ssh-section' },
                          h('input', { className: 'agy-ssh-input', type: 'password', value: password, onChange: e => setPassword(e.target.value), placeholder: uiText('输入 SSH 登录密码（仅加密存系统钥匙串）', 'SSH password (stored in OS keychain)') }),
                          h('label', { className: 'agy-ssh-check' },
                            h('input', { type: 'checkbox', checked: savePassword, onChange: e => setSavePassword(e.target.checked) }),
                            h('span', null, uiText('加密保存密码到系统钥匙串（下次无感直连）', 'Save password in OS keychain'))
                          ),
                          h('label', { className: 'agy-ssh-check' },
                            h('input', { type: 'checkbox', checked: installKeyOnCreate, onChange: e => setInstallKeyOnCreate(e.target.checked) }),
                            h('span', null, uiText('首次连上后自动写入免密公钥（推荐）', 'Auto-install local SSH public key (recommended)'))
                          )
                        )
                  ),
              h('div', { className: 'agy-ssh-row' },
                h('button', { type: 'button', className: 'agy-ssh-btn', disabled: testing, onClick: runTest }, testing ? uiText('测通中...', 'Testing...') : uiText('测试连接', 'Test connection')),
                isEdit && selectedHostId && h('button', { type: 'button', className: 'agy-ssh-btn', disabled: testing, onClick: handleInstallKey }, uiText('一键配免密公钥', 'Install SSH Key')),
                testResult?.ok && h('span', { className: 'agy-ssh-pill', style: { color: '#16a34a', borderColor: '#22c55e' } },
                  `✓ ${testResult.os} | ${testResult.latencyMs}ms | ${testResult.homeDir}`
                )
              )
            ),

            // 2. Remote Directory Section
            h('div', { className: 'agy-ssh-section' },
              h('span', { className: 'agy-ssh-label' }, uiText('2. 远端工作目录（选填，留空默认服务器主目录 ~）', '2. Remote Directory (optional, defaults to ~)')),
              h('div', { className: 'agy-ssh-row' },
                h('input', { className: 'agy-ssh-input', value: remoteDir, onChange: e => setRemoteDir(e.target.value), placeholder: uiText('例如 /root/autodl-tmp/my-model（可留空）', 'e.g. /root/my-project (optional)') }),
                h('button', { type: 'button', className: 'agy-ssh-btn', disabled: browsing, onClick: () => loadRemoteDir(remoteDir || '~') }, browsing ? uiText('读取中...', 'Loading...') : uiText('浏览目录', 'Browse'))
              ),
              showDirBrowser && h('div', { className: 'agy-ssh-list', style: { maxHeight: 160 } },
                h('div', { className: 'agy-ssh-row', style: { justifyContent: 'space-between', padding: '2px 4px', borderBottom: '1px solid var(--border)', paddingBottom: 6 } },
                  h('span', { style: { fontSize: 11.5, color: 'var(--muted-foreground)', overflow: 'hidden', textOverflow: 'ellipsis' } }, browsePath),
                  h('div', { className: 'agy-ssh-row', style: { gap: 4 } },
                    h('button', { type: 'button', className: 'agy-ssh-btn', style: { height: 24, fontSize: 11, padding: '0 8px' }, onClick: () => loadRemoteDir(parentBrowsePath()) }, '↑ ..'),
                    h('button', { type: 'button', className: 'agy-ssh-btn agy-ssh-btn-primary', style: { height: 24, fontSize: 11, padding: '0 8px' }, onClick: () => { setRemoteDir(browsePath); setShowDirBrowser(false); } }, uiText('选定此目录', 'Select'))
                  )
                ),
                browseEntries.map(dir => h('button', {
                  key: dir.path,
                  type: 'button',
                  className: 'agy-ssh-dir-item',
                  onClick: () => loadRemoteDir(dir.path)
                }, '📁 ', dir.name)),
                !browseEntries.length && h('div', { style: { padding: 8, color: 'var(--muted-foreground)', fontSize: 11.5 } }, uiText('此目录下没有子文件夹', 'No subdirectories'))
              )
            ),

            // 3. Project Display Name
            h('div', { className: 'agy-ssh-section' },
              h('span', { className: 'agy-ssh-label' }, uiText('3. 项目名称（选填）', '3. Project Name (optional)')),
              h('input', { className: 'agy-ssh-input', value: projectName, onChange: e => setProjectName(e.target.value), placeholder: uiText('留空自动按主机与目录命名', 'Auto-named from host and directory') })
            ),

            // 4. Collapsible Capability Scope (Q6=B)
            h('div', { className: 'agy-ssh-section', style: { borderTop: '1px solid var(--border)', paddingTop: 10 } },
              h('button', {
                type: 'button',
                className: 'agy-ssh-dir-item',
                style: { justifyContent: 'space-between', padding: '4px 2px', fontWeight: 500 },
                onClick: () => setCapExpanded(!capExpanded)
              },
                h('span', null, `${capExpanded ? '▾' : '▸'} ${uiText('本机 Skill 与插件能力范围（只筛不拷）', 'Local Skills & Plugins Scope')}`),
                h('span', { className: 'agy-ssh-pill' }, capMode === 'all' ? uiText('全部继承本机', 'Inherit all') : uiText(`已选 ${allowedSkills.size + allowedPlugins.size} 项`, `${allowedSkills.size + allowedPlugins.size} selected`))
              ),
              capExpanded && h('div', { className: 'agy-ssh-section' },
                h('div', { className: 'agy-ssh-tabs' },
                  h('button', { type: 'button', className: 'agy-ssh-tab', 'data-active': String(capMode === 'all'), onClick: () => setCapMode('all') }, uiText('全部继承本机（推荐）', 'Inherit all local')),
                  h('button', { type: 'button', className: 'agy-ssh-tab', 'data-active': String(capMode === 'selected'), onClick: () => setCapMode('selected') }, uiText('仅启用勾选的子集', 'Selected subset only'))
                ),
                capMode === 'selected' && h('div', { className: 'agy-ssh-section' },
                  h('div', { className: 'agy-ssh-row' },
                    h('input', {
                      className: 'agy-ssh-input',
                      style: { height: 28, fontSize: 12 },
                      value: capQuery,
                      onChange: e => setCapQuery(e.target.value),
                      placeholder: uiText('筛选 Skill 或插件名称...', 'Filter skills or plugins...')
                    }),
                    h('button', {
                      type: 'button',
                      className: 'agy-ssh-btn',
                      style: { height: 28, fontSize: 11.5, padding: '0 8px' },
                      onClick: () => {
                        setAllowedSkills(new Set(data.capabilities.skills.map(s => s.id)));
                        setAllowedPlugins(new Set(data.capabilities.plugins.map(p => p.id)));
                      }
                    }, uiText('全选', 'All')),
                    h('button', {
                      type: 'button',
                      className: 'agy-ssh-btn',
                      style: { height: 28, fontSize: 11.5, padding: '0 8px' },
                      onClick: () => {
                        setAllowedSkills(new Set());
                        setAllowedPlugins(new Set());
                      }
                    }, uiText('清空', 'None'))
                  ),
                  h('span', { className: 'agy-ssh-label' }, uiText(`本机 Skills (${data.capabilities.skills.length})`, `Local Skills (${data.capabilities.skills.length})`)),
                  h('div', { className: 'agy-ssh-cap-grid' },
                    data.capabilities.skills.filter(sk => !capQuery.trim() || `${sk.name} ${sk.description || ''}`.toLowerCase().includes(capQuery.trim().toLowerCase())).map(sk => h('label', { key: sk.id, className: 'agy-ssh-check', style: { minWidth: 0 } },
                      h('input', { type: 'checkbox', style: { flexShrink: 0 }, checked: allowedSkills.has(sk.id), onChange: () => toggleSet(allowedSkills, setAllowedSkills, sk.id) }),
                      h('span', { style: { fontWeight: 500, whiteSpace: 'nowrap', flexShrink: 0 } }, sk.name),
                      sk.description && h('span', { style: { color: 'var(--muted-foreground)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } }, sk.description)
                    )),
                    !data.capabilities.skills.length && h('span', { style: { color: 'var(--muted-foreground)', fontSize: 11.5 } }, uiText('未发现本机自定义 Skill', 'No local skills found'))
                  ),
                  h('span', { className: 'agy-ssh-label' }, uiText(`本机插件 / MCP (${data.capabilities.plugins.length})`, `Local Plugins / MCP (${data.capabilities.plugins.length})`)),
                  h('div', { className: 'agy-ssh-cap-grid' },
                    data.capabilities.plugins.filter(pl => !capQuery.trim() || `${pl.name} ${pl.id}`.toLowerCase().includes(capQuery.trim().toLowerCase())).map(pl => h('label', { key: pl.id, className: 'agy-ssh-check', style: { minWidth: 0 } },
                      h('input', { type: 'checkbox', style: { flexShrink: 0 }, checked: allowedPlugins.has(pl.id), onChange: () => toggleSet(allowedPlugins, setAllowedPlugins, pl.id) }),
                      h('span', { style: { fontWeight: 500, whiteSpace: 'nowrap', flexShrink: 0 } }, pl.name),
                      h('span', { className: 'agy-ssh-pill', style: { fontSize: 10, flexShrink: 0 } }, pl.kind)
                    )),
                    !data.capabilities.plugins.length && h('span', { style: { color: 'var(--muted-foreground)', fontSize: 11.5 } }, uiText('未发现其他插件/MCP', 'No other plugins/MCP found'))
                  )
                )
              )
            ),

            errorMsg && h('div', { style: { padding: '8px 10px', borderRadius: 8, background: 'color-mix(in srgb,#ef4444 12%,var(--background))', color: '#ef4444', fontSize: 12 } }, errorMsg)
          ),
          h('div', { className: 'agy-ssh-dialog-foot' },
            isEdit
              ? h('button', { type: 'button', className: 'agy-ssh-btn agy-ssh-btn-danger', disabled: submitting, onClick: handleDeleteBinding }, uiText('移除本地绑定（不删远端文件）', 'Unlink project'))
              : h('span', { style: { fontSize: 11.5, color: 'var(--muted-foreground)' } }, uiText('单窗口直连，免服务器额外授权', 'Single window, no remote auth')),
            h('div', { className: 'agy-ssh-row' },
              h('button', { type: 'button', className: 'agy-ssh-btn', onClick: onClose }, uiText('取消', 'Cancel')),
              h('button', { type: 'button', className: 'agy-ssh-btn agy-ssh-btn-primary', disabled: submitting, onClick: handleSubmit }, submitting ? uiText('处理中...', 'Saving...') : (isEdit ? uiText('保存更改', 'Save changes') : uiText('创建 SSH 项目', 'Create SSH Project')))
            )
          )
        )
      );
    }

    function TransferModal({ project, initialDirection, onClose }) {
      const uiText = env.uiText;
      const [direction, setDirection] = R.useState(initialDirection || 'upload');
      const [localPath, setLocalPath] = R.useState('');
      const [remotePath, setRemotePath] = R.useState(project?.remoteDir || '~');
      const [busy, setBusy] = R.useState(false);
      const [msg, setMsg] = R.useState('');

      const pickLocalFolder = async () => {
        try {
          const res = await env.request('workspace.pickFolder');
          if (res?.path) setLocalPath(res.path);
          else if (res?.uri) setLocalPath(decodeURIComponent(res.uri.replace(/^file:\/\//, '')));
        } catch {}
      };

      const runTransfer = async () => {
        setBusy(true);
        setMsg('');
        try {
          const res = await env.request('sshProject.transfer', {
            projectId: project.id,
            direction,
            localPath: localPath.trim(),
            remotePath: remotePath.trim()
          });
          env.notify?.({
            title: direction === 'upload' ? uiText('上传完成', 'Upload complete') : uiText('下载完成', 'Download complete'),
            message: `${res.localPath} ${direction === 'upload' ? '→' : '←'} ${res.remotePath}`
          });
          onClose();
        } catch (err) {
          setMsg(err?.message || uiText('传输失败', 'Transfer failed'));
        } finally {
          setBusy(false);
        }
      };

      return h('div', {
        className: 'agy-ssh-backdrop',
        'data-testid': 'agy-ssh-transfer-modal',
        'data-agy-powertools-root': 'ssh-transfer-modal',
        onClick: ev => { if (ev.target === ev.currentTarget) onClose(); }
      },
        h('div', { className: 'agy-ssh-dialog', style: { width: 'min(480px,94vw)' } },
          h('div', { className: 'agy-ssh-dialog-head' },
            h('div', { className: 'agy-ssh-dialog-title' }, cloudSshSvg(17), h('span', null, uiText('跨机文件互传', 'Cross-Machine File Transfer'))),
            h('button', { type: 'button', className: 'agy-ssh-btn', style: { width: 28, height: 28, padding: 0 }, onClick: onClose }, '✕')
          ),
          h('div', { className: 'agy-ssh-dialog-body' },
            h('div', { className: 'agy-ssh-tabs' },
              h('button', { type: 'button', className: 'agy-ssh-tab', 'data-active': String(direction === 'upload'), onClick: () => setDirection('upload') }, uiText('上传到服务器', 'Upload to server')),
              h('button', { type: 'button', className: 'agy-ssh-tab', 'data-active': String(direction === 'download'), onClick: () => setDirection('download') }, uiText('从服务器下载', 'Download to local'))
            ),
            h('div', { className: 'agy-ssh-section' },
              h('span', { className: 'agy-ssh-label' }, uiText('本机路径（文件或文件夹）', 'Local path (file or folder)')),
              h('div', { className: 'agy-ssh-row' },
                h('input', { className: 'agy-ssh-input', value: localPath, onChange: e => setLocalPath(e.target.value), placeholder: uiText('输入或选择本机路径', 'Local absolute path') }),
                h('button', { type: 'button', className: 'agy-ssh-btn', onClick: pickLocalFolder }, uiText('选目录', 'Browse'))
              )
            ),
            h('div', { className: 'agy-ssh-section' },
              h('span', { className: 'agy-ssh-label' }, uiText('远程服务器路径', 'Remote server path')),
              h('input', { className: 'agy-ssh-input', value: remotePath, onChange: e => setRemotePath(e.target.value), placeholder: '/root/project/...' })
            ),
            msg && h('div', { style: { color: '#ef4444', fontSize: 12 } }, msg)
          ),
          h('div', { className: 'agy-ssh-dialog-foot' },
            h('span', { style: { fontSize: 11.5, color: 'var(--muted-foreground)' } }, project?.host?.name || ''),
            h('div', { className: 'agy-ssh-row' },
              h('button', { type: 'button', className: 'agy-ssh-btn', onClick: onClose }, uiText('取消', 'Cancel')),
              h('button', { type: 'button', className: 'agy-ssh-btn agy-ssh-btn-primary', disabled: busy || !localPath.trim() || !remotePath.trim(), onClick: runTransfer }, busy ? uiText('传输中...', 'Transferring...') : uiText('开始传输', 'Start transfer'))
            )
          )
        )
      );
    }

    function SshTerminalPane() {
      const uiText = env.uiText;
      const [, force] = R.useState(0);
      R.useEffect(() => {
        const fn = () => force(n => n + 1);
        listeners.add(fn);
        return () => listeners.delete(fn);
      }, []);
      const proj = activeSshProject() || data.projects[0] || null;
      const [termId, setTermId] = R.useState('');
      const [output, setOutput] = R.useState('');
      const [cmdInput, setCmdInput] = R.useState('');
      const [errText, setErrText] = R.useState('');
      const outRef = R.useRef(null);

      const startTerm = R.useCallback(async targetProj => {
        if (!targetProj) return;
        setErrText('');
        try {
          const res = await env.request('sshProject.terminalStart', { projectId: targetProj.id, cwd: targetProj.remoteDir || '~' });
          setTermId(res.termId);
          setOutput(`[SSH Terminal] ${targetProj.host?.name || targetProj.hostId} (${targetProj.remoteDir || '~'})\n`);
        } catch (err) {
          setErrText(err?.message || uiText('终端启动失败', 'Failed to start terminal'));
        }
      }, [uiText]);

      R.useEffect(() => {
        if (!termId) return;
        let stop = false;
        const pollTimer = setInterval(async () => {
          if (stop) return;
          try {
            const res = await env.request('sshProject.terminalPoll', { termId });
            if (res?.output) {
              setOutput(prev => (prev + stripAnsi(res.output)).slice(-65536));
              if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
            }
            if (res?.closed) setTermId('');
          } catch {}
        }, 250);
        return () => { stop = true; clearInterval(pollTimer); };
      }, [termId]);

      const sendLine = async line => {
        if (!termId) return;
        try {
          await env.request('sshProject.terminalInput', { termId, data: line });
        } catch (err) {
          setErrText(err?.message || '');
        }
      };

      return h('div', { className: 'agy-ssh-term-root', 'data-testid': 'agy-ssh-terminal-pane' },
        h('div', { className: 'agy-ssh-term-head' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
            cloudSshSvg(15),
            h('span', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, proj ? `${proj.name}` : uiText('SSH 终端', 'SSH Terminal'))
          ),
          h('div', { className: 'agy-ssh-row', style: { gap: 4 } },
            !termId
              ? h('button', { type: 'button', className: 'agy-ssh-btn agy-ssh-btn-primary', style: { height: 24, fontSize: 11, padding: '0 8px' }, disabled: !proj, onClick: () => startTerm(proj) }, uiText('连接终端', 'Connect'))
              : h(R.Fragment, null,
                  h('button', { type: 'button', className: 'agy-ssh-btn', style: { height: 24, fontSize: 11, padding: '0 7px' }, onClick: () => sendLine('\x03') }, 'Ctrl+C'),
                  h('button', { type: 'button', className: 'agy-ssh-btn', style: { height: 24, fontSize: 11, padding: '0 7px' }, onClick: () => { void env.request('sshProject.terminalClose', { termId }).catch(() => {}); setTermId(''); } }, uiText('断开', 'Close'))
                ),
            h('button', { type: 'button', className: 'agy-ssh-btn', style: { height: 24, fontSize: 11, padding: '0 7px' }, onClick: () => setOutput('') }, uiText('清空', 'Clear'))
          )
        ),
        errText && h('div', { style: { padding: '6px 10px', color: '#ef4444', fontSize: 11.5, borderBottom: '1px solid var(--border)' } }, errText),
        h('pre', { ref: outRef, className: 'agy-ssh-term-out' }, output || (proj ? uiText('点击右上角「连接终端」即可直接操作远程服务器 Shell。', 'Click Connect to open an interactive shell on this Linux server.') : uiText('请先打开一个 SSH 项目。', 'Open an SSH project first.'))),
        h('form', {
          className: 'agy-ssh-term-in',
          onSubmit: ev => {
            ev.preventDefault();
            if (!termId) return;
            const text = cmdInput;
            setCmdInput('');
            void sendLine(`${text}\n`);
          }
        },
          h('input', {
            className: 'agy-ssh-input',
            style: { height: 30, fontFamily: 'var(--font-mono,monospace)' },
            disabled: !termId,
            value: cmdInput,
            onChange: e => setCmdInput(e.target.value),
            placeholder: termId ? uiText('输入远程命令回车执行（如 nvidia-smi）', 'Type remote command and press Enter...') : uiText('未连接', 'Not connected')
          }),
          h('button', { type: 'button', className: 'agy-ssh-btn', style: { height: 30 }, disabled: !termId, onClick: () => { const text = cmdInput; setCmdInput(''); void sendLine(`${text}\n`); } }, uiText('发送', 'Run'))
        )
      );
    }

    function OverlayHost() {
      const [, force] = R.useState(0);
      R.useEffect(() => {
        const fn = () => force(n => n + 1);
        listeners.add(fn);
        return () => listeners.delete(fn);
      }, []);

      const activeProj = enabled ? activeSshProject() : null;
      const st = activeProj ? (data.statuses?.[activeProj.hostId]?.status || 'offline') : 'offline';
      const uiText = env.uiText;

      return h(R.Fragment, null,
        activeProj && h('div', { className: 'agy-ssh-bar', 'data-testid': 'agy-ssh-status-bar', 'data-agy-powertools-root': 'ssh-status-bar' },
          cloudSshSvg(14),
          h('span', { className: 'agy-ssh-dot', style: { background: statusColor(st) } }),
          h('span', { style: { fontWeight: 500 } }, activeProj.host?.name || activeProj.hostId),
          h('span', { style: { color: 'var(--muted-foreground)' } }, activeProj.remoteDir || '~'),
          h('span', { style: { color: statusColor(st), fontSize: 11 } }, statusLabel(st, uiText)),
          h('button', {
            type: 'button',
            className: 'agy-ssh-bar-btn',
            onClick: () => {
              void env.request('sshProject.testHost', { hostId: activeProj.hostId })
                .then(r => { env.notify?.({ title: uiText('SSH 已连接', 'SSH connected'), message: `${r.os} | ${r.latencyMs}ms` }); return refreshData(); })
                .catch(err => env.notify?.({ title: uiText('重连失败', 'Reconnect failed'), message: err?.message || '' }));
            }
          }, uiText('重连', 'Reconnect')),
          h('button', { type: 'button', className: 'agy-ssh-bar-btn', onClick: () => openTransferModal(activeProj, 'upload') }, uiText('传文件', 'Transfer')),
          h('button', {
            type: 'button',
            className: 'agy-ssh-bar-btn',
            onClick: () => {
              registerTerminalPane();
              env.adapter?.toggleAuxPane?.();
            }
          }, uiText('终端', 'Terminal')),
          h('button', { type: 'button', className: 'agy-ssh-bar-btn', onClick: () => void openEditModal(activeProj) }, uiText('设置', 'Settings'))
        ),
        modalState && h(SshProjectModal, {
          mode: modalState.mode,
          project: modalState.project,
          onClose: () => { modalState = null; emit(); }
        }),
        transferState && h(TransferModal, {
          project: transferState.project,
          initialDirection: transferState.direction,
          onClose: () => { transferState = null; emit(); }
        })
      );
    }

    function ensureOverlay() {
      if (!doc || !doc.body || !globalThis.ReactDOM?.createRoot) return;
      if (!overlayMount || !overlayMount.isConnected) {
        overlayMount = doc.createElement('div');
        overlayMount.setAttribute('data-agy-powertools-root', 'ssh-projects-overlay');
        doc.body.appendChild(overlayMount);
        overlayRoot = globalThis.ReactDOM.createRoot(overlayMount);
        overlayRoot.render(h(OverlayHost));
      }
    }

    function registerTerminalPane() {
      if (!enabled || !env.adapter?.setCustomSidePanel) return;
      env.adapter.setCustomSidePanel(TERMINAL_PANE_KEY, {
        key: TERMINAL_PANE_KEY,
        title: env.uiText('SSH 终端', 'SSH Terminal'),
        icon: () => cloudSshSvg(15),
        component: SshTerminalPane
      }, true);
    }

    function sync(nextOpts = {}) {
      if (disposed) return;
      if (typeof nextOpts.enabled === 'boolean') enabled = nextOpts.enabled;
      if (!enabled) {
        env.adapter?.setCustomSidePanel?.(TERMINAL_PANE_KEY, null);
        syncSidebarIcons();
        emit();
        return;
      }
      ensureOverlay();
      if (!hydrated && !loading) void refreshData();
      injectAddResourceMenuItem();
      syncSidebarIcons();
      if (activeSshProject()) registerTerminalPane();
      emit();
    }

    function dispose() {
      disposed = true;
      enabled = false;
      syncSidebarIcons();
      env.adapter?.setCustomSidePanel?.(TERMINAL_PANE_KEY, null);
      for (const el of doc?.querySelectorAll?.('[data-testid="agy-ssh-add-resource-item"]') || []) el.remove();
      try { overlayRoot?.unmount?.(); } catch {}
      overlayMount?.remove?.();
      overlayRoot = null;
      overlayMount = null;
      styleEl?.remove?.();
      listeners.clear();
    }

    return { sync, refresh: refreshData, openCreateModal, openEditModal, dispose, get state() { return data; } };
  };
})();
