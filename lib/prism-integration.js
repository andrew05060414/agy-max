(() => {
  globalThis.__agyCreatePrismIntegration = function createPrismIntegration(env) {
    let optics, workbench, optionKey, lastExecution = null, lastExecutionKey, attemptedHomeLoad = false;
    let wallpaper = null;
    const opticsOptions = opts => ({ ...opts, contextStyle: 'ring', wallpaperEnabled: Boolean(opts.wallpaperEnabled && wallpaper) });
    function selectWallpaper(file) {
      if (file !== null && (!(file instanceof File) || !file.size || !/^(image\/(avif|gif|jpeg|png|webp)|video\/(mp4|webm))$/i.test(file.type))) {
        throw new Error(env.uiText('请选择支持的图片或视频', 'Choose a supported image or video'));
      }
      const previous = wallpaper;
      wallpaper = file ? { hasMedia: true, fileName: file.name, kind: file.type.startsWith('video/') ? 'video' : 'image', mediaUrl: URL.createObjectURL(file) } : null;
      // syncSettings lazily creates optics, so it must run before the wallpaper is handed to it.
      syncSettings();
      optics?.setWallpaperStatus(wallpaper);
      if (previous) URL.revokeObjectURL(previous.mediaUrl);
      return wallpaper?.fileName || '';
    }
    const workbenchOptions = opts => ({ ...opts, thoughtTranslate: 'off', translateSessionTitles: false, omniViewer: false });
    function syncSettings(refresh = false) {
      const opts = env.options();
      const key = JSON.stringify([opts, wallpaper?.mediaUrl]);
      if (optionKey !== key) {
        optionKey = key;
        const opt = opticsOptions(opts), bench = workbenchOptions(opts);
        optics ??= globalThis.__agyCreateOptics?.({ ...env, request: undefined, options: () => opticsOptions(env.options()) });
        workbench ??= globalThis.__agyCreateWorkbench?.({ ...env, options: () => workbenchOptions(env.options()) });
        optics?.sync(opt, lastExecution);
        workbench?.sync(bench);
      } else if (refresh) {
        workbench?.sync(workbenchOptions(opts));
      }
      const home = opts.enabled && opts.homeStudio && location.pathname === '/';
      if (!home) attemptedHomeLoad = false;
      else if (!attemptedHomeLoad && !env.dashboard()) {
        attemptedHomeLoad = true;
        void env.loadDashboard().catch(() => {});
      }
    }

    function syncExecution(execution) {
      lastExecution = execution;
      const key = JSON.stringify([execution?.conversationId, execution?.status, execution?.live?.waiting, Boolean(execution?.live?.errorText || execution?.live?.genError), execution?.live?.lastCase]);
      if (key === lastExecutionKey) return;
      lastExecutionKey = key;
      optics?.sync(opticsOptions(env.options()), execution);
    }

    function vialProps(data, source) {
      const cw = data?.contextWindow || {}, stats = data?.telemetry || {};
      const compact = () => {
        const composer = source?.closest?.('.surface-composer-card');
        if (!composer || !env.adapter.getComposerText || !env.adapter.setComposerText) return;
        if (env.adapter.getComposerText(composer)?.trim()) {
          env.notify({ title: env.uiText('请先处理输入框草稿', 'Keep or clear your current draft first'), tag: 'agy-vial-draft' });
          return;
        }
        env.adapter.setComposerText(composer, '/compact');
      };
      const norm = value => String(value || '').trim().toLowerCase();
      const systemNames = new Set(['system', 'system prompt', 'rules', 'skills', 'memory', 'memories', 'memory files', '系统提示', '规则', '技能', '记忆文件']);
      const messageNames = new Set(['messages', 'chat messages', 'conversation', 'user', 'assistant', 'input', 'input context', '输入上下文', '消息']);
      const toolNames = new Set(['tools', 'tool', 'system tools', 'mcp', 'mcp tools', 'plugins', 'subagents', '工具', '系统工具', 'mcp 工具', '插件', '子智能体']);
      let systemTokens = 0, messageTokens = 0, toolTokens = 0;
      for (const row of cw.categories || []) {
        if (!row) continue;
        const key = norm(row.key), label = norm(row.label);
        if (key === 'free' || row.tone === 'free') continue;
        const count = Number(row.tokens) || 0;
        if (systemNames.has(key) || systemNames.has(label)) systemTokens += count;
        else if (messageNames.has(key) || messageNames.has(label)) messageTokens += count;
        else if (toolNames.has(key) || toolNames.has(label)) toolTokens += count;
      }
      return {
        usedTokens: cw.usedTokens, maxTokens: cw.maxTokens, percent: cw.usedPercent,
        streaming: lastExecution?.conversationId === data?.conversationId && [2, 4].includes(lastExecution?.status),
        systemTokens, messageTokens, toolTokens,
        tps: stats.latestTps ?? stats.tps, ttftMs: stats.avgTtftMs, onCompact: compact
      };
    }

    return {
      syncSettings, syncExecution, vialProps, selectWallpaper, wallpaperName: () => wallpaper?.fileName || '',
      openPickedMedia: file => workbench?.openPickedMedia(file),
      mountVial: (element, props) => optics?.mountPopoverVial(element, props),
      dispose() { workbench?.dispose(); optics?.dispose(); if (wallpaper) URL.revokeObjectURL(wallpaper.mediaUrl); wallpaper = null; }
    };
  };
})();
