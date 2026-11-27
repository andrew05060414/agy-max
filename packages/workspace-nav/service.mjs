import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function registerModule(bus, ctx) {
  const importCoreLib = name => import(pathToFileURL(join(ctx.pluginRoot, 'lib', name)).href);
  const [
    { createPriorityStore },
    { searchTranscripts },
    { readGitFileDiff, readGitStatus },
    { createWorkspaceExplorer },
    { readDatabase },
    { copyLocalFile, openInExternalEditor, openLocalFile, readLocalFileForAttach, resolveVerifiedLocalFilePath },
    { parseRemoteUri },
    { resolveRemotePosixPath }
  ] = await Promise.all([
    importCoreLib('priority.mjs'),
    importCoreLib('transcript-search.mjs'),
    importCoreLib('git-status.mjs'),
    importCoreLib('workspace-explorer.mjs'),
    importCoreLib('database.mjs'),
    importCoreLib('launcher.mjs'),
    importCoreLib('ssh-runner.mjs'),
    importCoreLib('ssh-remote.mjs')
  ]);

  const priorityScopeFor = sshHost => sshHost ? `ssh:${sshHost}` : 'local';
  const priority = createPriorityStore(ctx.dataDir);
  const explorer = createWorkspaceExplorer({ dataDir: ctx.dataDir, appDir: ctx.appDir });

  bus.on('priority.initialState', 'workspace-nav', (_cur, { sshHost }) =>
    priority.get(priorityScopeFor(sshHost))
  );

  const resolveSsh = query => bus.runSync('ssh.resolveContext', null, query);

  bus.registerRpc('workspace-nav', 'priority.get', async (_request, rpcCtx) => {
    const sshHost = await rpcCtx.resolveHost();
    return priority.get(priorityScopeFor(sshHost));
  });

  bus.registerRpc('workspace-nav', 'priority.save', async (request, rpcCtx) => {
    const sshHost = await rpcCtx.resolveHost();
    return priority.save(priorityScopeFor(sshHost), { open: request.open, entries: request.entries });
  });

  bus.registerRpc('workspace-nav', 'sessions.search', async (request, rpcCtx) => {
    if (!ctx.settings.get().sessionSearch) throw new Error('会话搜索已关闭');
    const sshHost = await rpcCtx.resolveHost();
    const searchParams = {
      query: typeof request.query === 'string' ? request.query : '',
      scope: request.scope,
      conversationIds: Array.isArray(request.conversationIds) ? request.conversationIds : undefined,
      excludeIds: Array.isArray(request.excludeIds) ? request.excludeIds : undefined,
      maxResults: request.maxResults
    };
    return sshHost
      ? ctx.remote.search(sshHost, searchParams)
      : searchTranscripts(searchParams.query, searchParams);
  });

  bus.registerRpc('workspace-nav', 'file.open', async (request, rpcCtx) => {
    if (!ctx.settings.get().fileContextMenu && request.source !== 'file-tree') throw new Error('文件右键菜单已关闭');
    if (await rpcCtx.resolveHost()) throw new Error('SSH 远端文件暂不支持在本地直接打开，请使用“复制路径”');
    return openLocalFile(request.uri, { action: 'open' });
  });

  bus.registerRpc('workspace-nav', 'file.openEditor', async (request, rpcCtx) => {
    const current = ctx.settings.get();
    if (!current.fileContextMenu && request.source !== 'git' && request.source !== 'file-tree') throw new Error('文件右键菜单已关闭');
    if (await rpcCtx.resolveHost()) throw new Error('SSH 远端文件暂不支持在本地编辑器直接打开，请使用“复制路径”');
    return openInExternalEditor(request.uri, {
      preferred: current.externalEditor || 'auto',
      line: request.line ?? null,
      column: request.column ?? null
    });
  });

  bus.registerRpc('workspace-nav', 'file.reveal', async (request, rpcCtx) => {
    if (!ctx.settings.get().fileContextMenu) throw new Error('文件右键菜单已关闭');
    if (await rpcCtx.resolveHost()) throw new Error('SSH 远端文件暂不支持在本地直接打开，请使用“复制路径”');
    return openLocalFile(request.uri, { action: 'reveal' });
  });

  bus.registerRpc('workspace-nav', 'file.copy', async (request, rpcCtx) => {
    if (!ctx.settings.get().fileContextMenu) throw new Error('文件右键菜单已关闭');
    if (await rpcCtx.resolveHost()) throw new Error('SSH 远端文件暂不支持在本地直接打开，请使用“复制路径”');
    return copyLocalFile(request.uri);
  });

  bus.registerRpc('workspace-nav', 'file.path', async (request, rpcCtx) => {
    if (!ctx.settings.get().fileContextMenu) throw new Error('文件右键菜单已关闭');
    const parsedRemote = parseRemoteUri(request.uri);
    if (parsedRemote) return { ok: true, path: parsedRemote.path };
    const sshHost = await rpcCtx.resolveHost();
    return { ok: true, path: sshHost ? resolveRemotePosixPath(request.uri) : await resolveVerifiedLocalFilePath(request.uri) };
  });

  bus.registerRpc('workspace-nav', 'file.attach', async (request, rpcCtx) => {
    if (!ctx.settings.get().fileContextMenu && request.source !== 'git' && request.source !== 'file-tree') throw new Error('文件右键菜单已关闭');
    const parsedRemote = parseRemoteUri(request.uri);
    if (parsedRemote) {
      const remotePath = parsedRemote.path;
      const name = remotePath.split('/').filter(Boolean).pop() || remotePath;
      return { ok: true, mode: 'mention', kind: request.isDirectory ? 'directory' : 'file', uri: String(request.uri || '').trim(), path: remotePath, name, isDirectory: Boolean(request.isDirectory) };
    }
    const sshHost = await rpcCtx.resolveHost();
    if (sshHost) {
      const remotePath = resolveRemotePosixPath(request.uri);
      const cleanUri = String(request.uri || '').trim();
      const name = remotePath.split('/').filter(Boolean).pop() || remotePath;
      return { ok: true, mode: 'mention', kind: request.isDirectory ? 'directory' : 'file', uri: cleanUri, path: remotePath, name, isDirectory: Boolean(request.isDirectory) };
    }
    return readLocalFileForAttach(request.uri);
  });

  bus.registerRpc('workspace-nav', 'git.status', async (request, rpcCtx) => {
    if (!ctx.settings.get().gitStatusPill) return { ok: true, isRepo: false };
    if (await rpcCtx.resolveHost()) return { ok: true, isRepo: false, sshUnsupported: true };
    const sshCtx = resolveSsh({ workspaceUri: request.workspaceUri, conversationId: request.conversationId });
    if (sshCtx?.project?.hostId) {
      return sshCtx.runner.gitStatus(sshCtx.project.hostId, sshCtx.project.remoteDir || '~');
    }
    let wsUri = typeof request.workspaceUri === 'string' ? request.workspaceUri.trim() : '';
    if (!wsUri && typeof request.conversationId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(request.conversationId)) {
      wsUri = readDatabase(ctx.appDir, request.conversationId)?.workspaceUri || '';
    }
    return wsUri ? readGitStatus(wsUri, { force: request.force === true }) : { ok: true, isRepo: false };
  });

  bus.registerRpc('workspace-nav', 'git.diff', async (request, rpcCtx) => {
    if (!ctx.settings.get().gitStatusPill) throw new Error('Git 状态胶囊已关闭');
    if (await rpcCtx.resolveHost()) throw new Error('SSH 远端窗口暂不支持本地 Git 差异预览');
    const sshCtx = resolveSsh({ workspaceUri: request.workspaceUri, conversationId: request.conversationId });
    if (sshCtx?.project?.hostId) {
      return sshCtx.runner.gitDiff(sshCtx.project.hostId, sshCtx.project.remoteDir || '~', request.path, request.status || '');
    }
    let wsUri = typeof request.workspaceUri === 'string' ? request.workspaceUri.trim() : '';
    if (!wsUri && typeof request.conversationId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(request.conversationId)) {
      wsUri = readDatabase(ctx.appDir, request.conversationId)?.workspaceUri || '';
    }
    return readGitFileDiff(wsUri, request.path, { status: request.status || '' });
  });

  bus.registerRpc('workspace-nav', 'workspace.recent', async (request, rpcCtx) => {
    if (await rpcCtx.resolveHost()) return { ok: true, sshRemote: true, workspaces: [] };
    return { ok: true, workspaces: explorer.recentWorkspaces({ clientWorkspaces: request.clientWorkspaces }) };
  });

  bus.registerRpc('workspace-nav', 'workspace.mount', async (request, rpcCtx) => {
    if (await rpcCtx.resolveHost()) throw new Error('SSH 远端窗口请使用客户端原生远程工作区');
    const sshCtx = resolveSsh({ workspaceUri: request.uri });
    if (sshCtx?.project) return { ok: true, uri: sshCtx.project.workspaceUri, name: sshCtx.project.name, sshProject: true };
    return explorer.mountWorkspace(request.uri);
  });

  bus.registerRpc('workspace-nav', 'workspace.listDir', async (request, rpcCtx) => {
    if (await rpcCtx.resolveHost()) throw new Error('SSH 远端窗口暂不支持本地文件树读取');
    const sshCtx = resolveSsh({ workspaceUri: request.rootUri });
    if (sshCtx?.project?.hostId) {
      return sshCtx.runner.listDir(sshCtx.project.hostId, sshCtx.project.remoteDir || '~', request.relPath || '');
    }
    return explorer.listDir({ rootUri: request.rootUri, relPath: request.relPath });
  });

  bus.registerRpc('workspace-nav', 'workspace.searchFiles', async (request, rpcCtx) => {
    if (await rpcCtx.resolveHost()) throw new Error('SSH 远端窗口暂不支持本地文件筛选');
    const sshCtx = resolveSsh({ workspaceUri: request.rootUri });
    if (sshCtx?.project?.hostId) {
      return sshCtx.runner.searchFiles(sshCtx.project.hostId, sshCtx.project.remoteDir || '~', { query: request.query, mode: 'files', maxResults: request.limit });
    }
    return explorer.searchFiles({ rootUri: request.rootUri, query: request.query, limit: request.limit });
  });

  bus.registerRpc('workspace-nav', 'workspace.readFile', async (request, rpcCtx) => {
    if (await rpcCtx.resolveHost()) throw new Error('SSH 远端窗口暂不支持本地文件预览');
    const sshCtx = resolveSsh({ uri: request.fileUri, workspaceUri: request.rootUri });
    if (sshCtx?.project?.hostId) {
      return sshCtx.runner.readFile(sshCtx.project.hostId, request.fileUri);
    }
    return explorer.readFilePreview({ rootUri: request.rootUri, fileUri: request.fileUri });
  });

  bus.registerRpc('workspace-nav', 'workspace.writeFile', async (request, rpcCtx) => {
    if (await rpcCtx.resolveHost()) throw new Error('SSH 远端窗口暂不支持本地文件编辑');
    const sshCtx = resolveSsh({ uri: request.fileUri, workspaceUri: request.rootUri });
    if (sshCtx?.project?.hostId) {
      return sshCtx.runner.writeFile(sshCtx.project.hostId, request.fileUri, request.content, { expectedMtimeMs: request.expectedMtimeMs, overwrite: request.overwrite === true });
    }
    return explorer.writeTextFile({ rootUri: request.rootUri, fileUri: request.fileUri, content: request.content, expectedMtimeMs: request.expectedMtimeMs, overwrite: request.overwrite === true });
  });

  bus.registerRpc('workspace-nav', 'workspace.pickFolder', async (_request, rpcCtx) => {
    if (await rpcCtx.resolveHost()) throw new Error('SSH 远端窗口不支持打开本机文件夹选择器');
    return explorer.pickFolder();
  });
}
