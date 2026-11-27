import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function registerModule(bus, ctx) {
  const importCoreLib = name => import(pathToFileURL(join(ctx.pluginRoot, 'lib', name)).href);
  const [
    { createGoalsStore, resolveConversationGoal, syncConversationGoal },
    { formatConversationMarkdown },
    { createPrismService },
    { readDatabase }
  ] = await Promise.all([
    importCoreLib('goals.mjs'),
    importCoreLib('session-parser.mjs'),
    importCoreLib('prism-service.mjs'),
    importCoreLib('database.mjs')
  ]);

  const goals = createGoalsStore(ctx.dataDir);
  const prism = createPrismService({
    settings: ctx.settings,
    dataDir: ctx.dataDir,
    workspaceOf: id => readDatabase(ctx.appDir, id)?.workspaceUri
  });

  bus.on('state.enrich', 'chat-flow', (acc, { parsed, conversationId, execution, curSettings }) => {
    const goal = curSettings.goalBar
      ? syncConversationGoal(conversationId, parsed.transcriptGoal, goals, {
          turns: parsed.turns,
          executions: parsed.executions,
          execution
        })
      : null;
    return { ...acc, goal };
  });

  bus.registerRpc('chat-flow', 'goal.save', request => {
    if (!ctx.settings.get().goalBar) throw new Error('目标栏功能已关闭');
    const saved = goals.save(request.conversationId, {
      text: request.text,
      checklist: request.checklist,
      guardrails: request.guardrails,
      sourceStepIndex: request.sourceStepIndex,
      currentStepIndex: request.currentStepIndex,
      startedAtMs: request.startedAtMs
    });
    return { ok: true, goal: resolveConversationGoal(null, saved) };
  });

  bus.registerRpc('chat-flow', 'goal.setStatus', request => {
    if (!ctx.settings.get().goalBar) throw new Error('目标栏功能已关闭');
    const saved = goals.setStatus(request.conversationId, request.status, {
      fallbackText: request.text,
      sourceStepIndex: request.sourceStepIndex,
      currentStepIndex: request.currentStepIndex,
      startedAtMs: request.startedAtMs
    });
    return {
      ok: true,
      goal: resolveConversationGoal(request.hadNativeGoal ? { status: 'active', stepIndex: -1 } : null, saved)
    };
  });

  bus.registerRpc('chat-flow', 'sessions.markdown', async (request, rpcCtx) => {
    if (!ctx.settings.get().copySessionMarkdown) throw new Error('复制会话为 Markdown 功能已关闭');
    const sshHost = await rpcCtx.resolveHost();
    const mdParams = {
      conversationId: typeof request.conversationId === 'string' ? request.conversationId : '',
      upToTurn: request.upToTurn ?? null,
      title: typeof request.title === 'string' ? request.title.slice(0, 160) : '',
      language: ctx.settings.get().language || 'zh-CN'
    };
    return sshHost
      ? ctx.remote.markdown(sshHost, mdParams)
      : formatConversationMarkdown(mdParams.conversationId, mdParams);
  });

  bus.registerRpc('chat-flow', new Set(['diff.inline', 'chatFolders.get', 'chatFolders.save']), async (request, rpcCtx) => {
    const remoteWindow = request.method === 'diff.inline' && (Boolean(await rpcCtx.resolveHost()) || rpcCtx.sshKind === 'ssh');
    return prism.request(request, { remoteWindow });
  });
}
