import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createSshProjectsStore, normalizeCapabilityScope, readSshProjectMarker } from './ssh-projects.mjs';

const SSH_MCP_ID = 'agy-ssh-projects';

function isPathInside(rootDir, targetPath, platform = process.platform) {
  if (!rootDir || !targetPath) return false;
  const norm = p => {
    const abs = resolve(p);
    return platform === 'win32' ? abs.toLowerCase() : abs;
  };
  const rel = relative(norm(rootDir), norm(targetPath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function extractSkillOrPluginFromPath(targetPath, { home = homedir(), platform = process.platform } = {}) {
  const cfgRoot = join(home, '.gemini', 'config');
  const skillsRoot = join(cfgRoot, 'skills');
  const pluginsRoot = join(cfgRoot, 'plugins');
  const builtinRoot = join(home, '.gemini', 'antigravity', 'builtin', 'skills');
  if (isPathInside(builtinRoot, targetPath, platform)) return { kind: 'builtin-skill', name: '' };
  if (isPathInside(skillsRoot, targetPath, platform)) {
    const rel = relative(resolve(skillsRoot), resolve(targetPath)).replaceAll('\\', '/');
    const name = rel.split('/').filter(Boolean)[0] || '';
    return { kind: 'skill', name };
  }
  if (isPathInside(pluginsRoot, targetPath, platform)) {
    const rel = relative(resolve(pluginsRoot), resolve(targetPath)).replaceAll('\\', '/');
    const parts = rel.split('/').filter(Boolean);
    const pluginName = parts[0] || '';
    const skillName = parts[1] === 'skills' ? (parts[2] || '') : '';
    return { kind: 'plugin', pluginName, skillName };
  }
  return null;
}

function extractMcpServer(toolName, args = {}) {
  if (toolName === 'call_mcp_tool') {
    return String(args.ServerName || args.serverName || '').trim();
  }
  if (toolName.startsWith('mcp_')) {
    // Format: mcp_<server>_<tool> (server names may contain hyphens or underscores like agy-fast_fast)
    const rest = toolName.slice(4);
    if (rest.startsWith(`${SSH_MCP_ID}_`)) return SSH_MCP_ID;
    if (rest.startsWith('agy-fast_fast_')) return 'agy-fast';
    const idx = rest.indexOf('_');
    return idx > 0 ? rest.slice(0, idx) : rest;
  }
  return '';
}

function resolveProjectFromHookPayload(payload = {}) {
  const candidates = [
    payload.cwd,
    ...(Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [])
  ].filter(Boolean);
  for (const candidate of candidates) {
    const marker = readSshProjectMarker(candidate);
    if (!marker) continue;
    let project = null;
    try {
      const store = createSshProjectsStore({ dataDir: marker.dataDir });
      project = store.getProject(marker.projectId);
    } catch {}
    const hostLabel = project?.host?.name || project?.host?.host || marker.hostLabel || marker.hostId;
    return {
      projectId: project?.id || marker.projectId,
      name: project?.name || marker.name || hostLabel,
      hostId: project?.hostId || marker.hostId,
      hostLabel,
      host: project?.host || null,
      remoteDir: project?.remoteDir ?? marker.remoteDir ?? '',
      capabilityScope: normalizeCapabilityScope(project?.capabilityScope || marker.capabilityScope),
      workspaceDir: marker.workspaceDir
    };
  }
  return null;
}

function formatHostSpec(ctx) {
  if (!ctx.host) return ctx.hostLabel;
  const user = ctx.host.user ? `${ctx.host.user}@` : '';
  const port = ctx.host.port && ctx.host.port !== 22 ? `:${ctx.host.port}` : '';
  return `${ctx.host.name} (${user}${ctx.host.host}${port})`;
}

export function evaluateSshBoundaryHook(payload = {}, { home = homedir(), platform = process.platform } = {}) {
  const event = String(payload.hookEventName || '').trim();
  const passThrough = () => (event === 'PreToolUse' ? { decision: 'allow' } : {});
  const ctx = resolveProjectFromHookPayload(payload);
  if (!ctx) return passThrough();

  const remoteRoot = ctx.remoteDir || '~';
  const hostDesc = formatHostSpec(ctx);

  if (event === 'SessionStart') {
    const scopeLines = ctx.capabilityScope.mode === 'selected'
      ? [
          `- 本项目能力范围（仅允许使用以下本机扩展）：`,
          `  - 允许的 Skills: ${ctx.capabilityScope.allowedSkills.length ? ctx.capabilityScope.allowedSkills.join(', ') : '（无）'}`,
          `  - 允许的 Plugins/MCP: ${ctx.capabilityScope.allowedPlugins.length ? ctx.capabilityScope.allowedPlugins.join(', ') : '（无，仅保留 SSH 工具）'}`,
          `  - 严禁读取或调用上述清单之外的 Skill 或第三方插件工具。`
        ]
      : ['- 本项目能力范围：全部继承本机 Skills 与插件。'];

    const message = [
      `[Antigravity Max SSH Project Context]`,
      `当前会话属于 SSH 远程项目「${ctx.name}」（projectId: ${ctx.projectId}）。`,
      `- 目标 Linux 主机：${hostDesc}`,
      `- 远端工作目录：${remoteRoot}`,
      `- 远端执行边界（ADR-0002）：`,
      `  - 所有代码读取/编辑/写入/搜索与命令执行必须调用 agy-ssh-projects MCP 工具（ssh_read_file / ssh_edit_file / ssh_write_file / ssh_list_dir / ssh_search / ssh_run_command / ssh_job_status / ssh_job_kill），并传入 projectId: "${ctx.projectId}"。`,
      `  - 禁止对本机项目目录执行普通本地 run_command / read_file / edit_file / write_file（仅对话 artifact 目录与允许的本地 Skill 文档除外）。`,
      `  - 如需在本机与服务器之间上传或下载文件，请显式调用 ssh_transfer。`,
      `  - ssh_read_file 原生支持读取远端图片与 .ipynb Notebook，可直接查看服务器生成的图表。`,
      ...scopeLines
    ].join('\n');

    return {
      injectSteps: [
        { systemMessage: { systemMessage: message } }
      ]
    };
  }

  if (event === 'PreToolUse') {
    const toolName = String(payload.toolCall?.name || '').trim();
    const args = payload.toolCall?.args && typeof payload.toolCall.args === 'object' ? payload.toolCall.args : {};
    const artifactDir = String(payload.artifactDirectoryPath || '').trim();

    if (!toolName) return passThrough();

    // Always allow our own SSH project MCP tools (remote permissions follow native conversation policy)
    if (toolName.startsWith(`mcp_${SSH_MCP_ID}_`) || toolName.startsWith('ssh_')) return passThrough();
    const mcpServer = extractMcpServer(toolName, args);
    if (mcpServer === SSH_MCP_ID) return passThrough();

    // Block local shell execution inside SSH projects
    if (toolName === 'run_command') {
      return {
        decision: 'deny',
        reason: `当前为 SSH 项目「${ctx.name}」（${hostDesc}:${remoteRoot}），禁止直接运行本机命令。请改用 ssh_run_command（projectId: "${ctx.projectId}"）；如需本机与服务器互传文件，请使用 ssh_transfer。`
      };
    }

    // Local agy-fast operates on local disk, so redirect inside SSH projects
    if (mcpServer === 'agy-fast') {
      return {
        decision: 'deny',
        reason: `当前为 SSH 项目「${ctx.name}」，agy-fast 仅作用于本机磁盘。请改用 ssh_search / ssh_read_file / ssh_edit_file / ssh_run_command（projectId: "${ctx.projectId}"）。`
      };
    }

    // Check write_file / edit_file: only allow writing inside conversation artifact directory
    if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'replace_file_content' || toolName === 'multi_replace_file_content') {
      const targetPath = String(args.Path || args.path || args.TargetFile || '').trim();
      if (artifactDir && targetPath && isPathInside(artifactDir, targetPath, platform)) {
        return passThrough();
      }
      return {
        decision: 'deny',
        reason: `当前为 SSH 项目「${ctx.name}」（${hostDesc}:${remoteRoot}），禁止直接修改本机文件。请改用 ssh_write_file / ssh_edit_file（projectId: "${ctx.projectId}"）；如需回传文件到本机，请使用 ssh_transfer。`
      };
    }

    // Check read_file / view_file: allow artifact dir and allowed local skills; redirect everything else to ssh_read_file
    if (toolName === 'read_file' || toolName === 'view_file') {
      const targetPath = String(args.Path || args.path || args.AbsolutePath || '').trim();
      if (!targetPath) return passThrough();
      if (artifactDir && isPathInside(artifactDir, targetPath, platform)) return passThrough();
      const cap = extractSkillOrPluginFromPath(targetPath, { home, platform });
      if (cap) {
        if (cap.kind === 'builtin-skill') return passThrough();
        if (ctx.capabilityScope.mode === 'selected') {
          if (cap.kind === 'skill' && cap.name && !ctx.capabilityScope.allowedSkills.includes(cap.name)) {
            return {
              decision: 'deny',
              reason: `当前 SSH 项目「${ctx.name}」的能力范围未启用 Skill「${cap.name}」，可在 SSH 项目设置中勾选启用。`
            };
          }
          if (cap.kind === 'plugin' && cap.pluginName && cap.pluginName !== 'agy-max') {
            const pluginAllowed = ctx.capabilityScope.allowedPlugins.includes(cap.pluginName);
            const skillAllowed = cap.skillName && ctx.capabilityScope.allowedSkills.includes(cap.skillName);
            if (!pluginAllowed && !skillAllowed) {
              return {
                decision: 'deny',
                reason: `当前 SSH 项目「${ctx.name}」的能力范围未启用插件「${cap.pluginName}」，可在 SSH 项目设置中勾选启用。`
              };
            }
          }
        }
        return passThrough();
      }
      return {
        decision: 'deny',
        reason: `当前为 SSH 项目「${ctx.name}」（${hostDesc}:${remoteRoot}），禁止直接读取本机磁盘文件。请改用 ssh_read_file（projectId: "${ctx.projectId}"）；如需上传本机文件到服务器，请使用 ssh_transfer。`
      };
    }

    // Enforce project capability scope on third-party MCP plugins
    if (mcpServer && ctx.capabilityScope.mode === 'selected') {
      const allowed = ctx.capabilityScope.allowedPlugins.some(item => item === mcpServer || mcpServer.startsWith(`${item}_`) || mcpServer.startsWith(`${item}-`));
      if (!allowed) {
        return {
          decision: 'deny',
          reason: `当前 SSH 项目「${ctx.name}」的能力范围未启用插件/MCP「${mcpServer}」，可在 SSH 项目设置中勾选启用。`
        };
      }
    }
    return passThrough();
  }

  return passThrough();
}
