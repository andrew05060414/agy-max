import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function registerModule(bus, ctx) {
  const importCoreLib = name => import(pathToFileURL(join(ctx.pluginRoot, 'lib', name)).href);
  const [
    { createSshProjectsStore },
    { createSshRunner, parseRemoteUri },
    { saveHostToSshConfig },
    { readDatabase }
  ] = await Promise.all([
    importCoreLib('ssh-projects.mjs'),
    importCoreLib('ssh-runner.mjs'),
    importCoreLib('ssh-config.mjs'),
    importCoreLib('database.mjs')
  ]);

  const sshProjects = createSshProjectsStore({ dataDir: join(ctx.dataDir, 'ssh-projects') });
  const sshRunner = createSshRunner({ store: sshProjects });
  const sshTerminalBuffers = new Map();

  bus.onUnload('ssh-remote', () => {
    sshRunner.closeAll();
    sshTerminalBuffers.clear();
  });

  function resolveSshProjectForContext({ uri = '', workspaceUri = '', conversationId = '' } = {}) {
    for (const candidate of [uri, workspaceUri]) {
      const parsed = parseRemoteUri(candidate);
      if (parsed?.hostId) {
        const match = sshProjects.listProjects().find(p => p.hostId === parsed.hostId);
        if (match) return match;
        const host = sshProjects.getHost(parsed.hostId);
        if (host) return { id: '', hostId: host.id, host, remoteDir: '' };
      }
      if (candidate) {
        const found = sshProjects.findProjectByWorkspace(candidate);
        if (found) return found;
      }
    }
    if (conversationId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(conversationId)) {
      const ws = readDatabase(ctx.appDir, conversationId)?.workspaceUri || '';
      if (ws) return sshProjects.findProjectByWorkspace(ws);
    }
    return null;
  }

  bus.on('ssh.resolveContext', 'ssh-remote', (_cur, query = {}) => {
    const project = resolveSshProjectForContext(query);
    return project ? { project, runner: sshRunner } : null;
  });

  bus.registerRpc('ssh-remote', 'sshProject.', async (request, rpcCtx) => {
    if (await rpcCtx.resolveHost()) throw new Error('SSH 项目管理仅在本地主窗口可用');
    if (request.method === 'sshProject.list') {
      return {
        ok: true,
        hosts: sshProjects.listHosts(),
        projects: sshProjects.listProjects(),
        statuses: sshRunner.getAllStatuses(),
        configHosts: sshProjects.listConfigHosts(),
        capabilities: sshProjects.discoverCapabilities()
      };
    }
    if (request.method === 'sshProject.saveHost') {
      return { ok: true, host: sshProjects.upsertHost(request) };
    }
    if (request.method === 'sshProject.deleteHost') {
      return sshProjects.deleteHost(request.hostId, { force: request.force === true });
    }
    if (request.method === 'sshProject.testHost') {
      const target = request.hostId ? sshProjects.getHost(request.hostId) : {
        id: request.id || '',
        name: request.name || request.configAlias || request.host || 'ssh',
        configAlias: request.configAlias || '',
        host: request.host || '',
        user: request.user || '',
        port: Number(request.port || 22),
        authType: request.authType || (request.password ? 'password' : 'key'),
        identityFile: request.identityFile || '',
        proxyJump: request.proxyJump || ''
      };
      if (!target) throw new Error('SSH 主机不存在');
      return sshRunner.testConnection(target, { passwordOverride: request.password || '' });
    }
    if (request.method === 'sshProject.installKey') {
      const host = sshProjects.getHost(request.hostId);
      if (!host) throw new Error('SSH 主机不存在');
      const installed = await sshRunner.installPublicKey(host, { passwordOverride: request.password || '' });
      const updatedHost = sshProjects.upsertHost({
        id: host.id,
        authType: 'key',
        identityFile: installed.privateKeyPath,
        clearPassword: request.clearPassword === true
      });
      return { ...installed, host: updatedHost };
    }
    if (request.method === 'sshProject.browseDir') {
      const target = request.hostId ? sshProjects.getHost(request.hostId) : {
        id: request.id || '',
        name: request.name || request.configAlias || request.host || 'ssh',
        configAlias: request.configAlias || '',
        host: request.host || '',
        user: request.user || '',
        port: Number(request.port || 22),
        authType: request.authType || (request.password ? 'password' : 'key'),
        identityFile: request.identityFile || '',
        proxyJump: request.proxyJump || ''
      };
      if (!target) throw new Error('SSH 主机不存在');
      return sshRunner.listDir(target, request.path || '~', '', { passwordOverride: request.password || '' });
    }
    if (request.method === 'sshProject.create') {
      const project = sshProjects.createProject({
        name: request.name,
        hostId: request.hostId,
        remoteDir: request.remoteDir,
        nativeProjectId: request.nativeProjectId,
        capabilityScope: request.capabilityScope
      });
      return { ok: true, project };
    }
    if (request.method === 'sshProject.update') {
      const project = sshProjects.updateProject(request.projectId, {
        name: request.name,
        hostId: request.hostId,
        remoteDir: request.remoteDir,
        nativeProjectId: request.nativeProjectId,
        capabilityScope: request.capabilityScope
      });
      return { ok: true, project };
    }
    if (request.method === 'sshProject.delete') {
      return sshProjects.deleteProject(request.projectId);
    }
    if (request.method === 'sshProject.disconnect') {
      return sshRunner.disconnect(request.hostId);
    }
    if (request.method === 'sshProject.transfer') {
      const proj = sshProjects.getProject(request.projectId);
      const hostId = proj?.hostId || request.hostId;
      if (!hostId) throw new Error('缺少 SSH 主机或项目标识');
      return sshRunner.transfer(hostId, {
        direction: request.direction,
        localPath: request.localPath,
        remotePath: request.remotePath
      });
    }
    if (request.method === 'sshProject.terminalStart') {
      const proj = sshProjects.getProject(request.projectId);
      const hostId = proj?.hostId || request.hostId;
      if (!hostId) throw new Error('缺少 SSH 主机或项目标识');
      const termState = { chunks: [], closed: false, exitCode: null };
      const started = sshRunner.startTerminal(hostId, {
        cwd: request.cwd || proj?.remoteDir || '~',
        cols: request.cols,
        rows: request.rows,
        onData(chunk) {
          termState.chunks.push(chunk);
          if (termState.chunks.length > 400) termState.chunks.splice(0, termState.chunks.length - 400);
        },
        onExit(code) {
          termState.closed = true;
          termState.exitCode = code;
        }
      });
      sshTerminalBuffers.set(started.termId, termState);
      return started;
    }
    if (request.method === 'sshProject.terminalInput') {
      return sshRunner.writeTerminal(request.termId, request.data);
    }
    if (request.method === 'sshProject.terminalPoll') {
      const buf = sshTerminalBuffers.get(request.termId);
      if (!buf) return { ok: true, output: '', closed: true, exitCode: 0 };
      const output = buf.chunks.join('');
      buf.chunks.length = 0;
      if (buf.closed) sshTerminalBuffers.delete(request.termId);
      return { ok: true, output, closed: buf.closed, exitCode: buf.exitCode };
    }
    if (request.method === 'sshProject.terminalClose') {
      sshTerminalBuffers.delete(request.termId);
      return sshRunner.closeTerminal(request.termId);
    }
    throw new Error('不支持的 SSH 项目操作');
  });

  bus.registerRpc('ssh-remote', 'ssh.saveConfigHost', async (request, rpcCtx) => {
    if (!ctx.settings.get().sshCommandPaste) throw new Error('SSH 命令识别已关闭');
    if (await rpcCtx.resolveHost()) throw new Error('仅支持在本地窗口保存 ~/.ssh/config');
    return saveHostToSshConfig({
      alias: request.alias,
      host: request.host,
      user: request.user,
      port: request.port,
      identityFile: request.identityFile,
      proxyJump: request.proxyJump,
      forwardAgent: request.forwardAgent
    });
  });
}
