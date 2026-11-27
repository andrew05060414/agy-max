import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compactGeneration, contextSnapshot, modelContexts } from './context.mjs';
import { readDatabase } from './database.mjs';
import { requestEvents } from './analytics.mjs';
import { readProgress, resolveTurnExecution } from './progress.mjs';
import { extractTranscriptGoal } from './goals.mjs';

export const getAppDataDir = () => process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity');
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id);
const transcriptPath = (id, dir = getAppDataDir()) => join(dir, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
const readLines = path => {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  catch { return []; }
};
const cleanPrompt = content => {
  const raw = typeof content === 'string' ? content : '';
  return raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/)?.[1]?.trim() || raw.trim() || '会话';
};
const iso = ms => Number.isFinite(ms) ? new Date(ms).toISOString() : null;
const number = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const elapsed = (start, end) => Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
const titleCache = new Map();

export function listRecentConversations({ appDataDir } = {}) {
  const dir = appDataDir || getAppDataDir();
  const brain = join(dir, 'brain');
  if (!existsSync(brain)) return [];
  return readdirSync(brain, { withFileTypes: true }).filter(d => d.isDirectory() && validId(d.name)).flatMap(d => {
    try { return [{ conversationId: d.name, updatedAtMs: statSync(transcriptPath(d.name, dir)).mtimeMs }]; }
    catch { return []; }
  }).sort((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, 12).map(s => {
    const cacheKey = `${dir}\0${s.conversationId}`;
    let cached = titleCache.get(cacheKey);
    if (cached?.mtime !== s.updatedAtMs) {
      const first = readLines(transcriptPath(s.conversationId, dir)).find(step => step.type === 'USER_INPUT');
      cached = { mtime: s.updatedAtMs, title: cleanPrompt(first?.content).split('\n')[0].slice(0, 60) };
      titleCache.set(cacheKey, cached);
      if (titleCache.size > 24) titleCache.delete(titleCache.keys().next().value);
    }
    return { ...s, title: cached.title, updatedAtIso: iso(s.updatedAtMs) };
  });
}

export function resolveConversationId(requestedId, { appDataDir } = {}) {
  const dir = appDataDir || getAppDataDir();
  if (requestedId) return validId(requestedId) && existsSync(transcriptPath(requestedId, dir)) ? requestedId : '';
  const envId = process.env.ANTIGRAVITY_CONVERSATION_ID;
  if (validId(envId) && existsSync(transcriptPath(envId, dir))) return envId;
  return listRecentConversations({ appDataDir: dir })[0]?.conversationId || '';
}

function classify(call) {
  const name = call?.name || 'tool';
  const args = Object.fromEntries(Object.entries(call?.args || {}).map(([key, value]) => {
    if (typeof value === 'string' && value.startsWith('"')) { try { value = JSON.parse(value); } catch {} }
    return [key, value];
  }));
  const path = args.Path || args.AbsolutePath || args.DirectoryPath || args.TargetFile || '';
  const file = basename(String(path).replace(/\\/g, '/'));
  let groupKey = 'other', groupLabel = '工具调用', itemLabel = name;
  if (/run_command|command_status/.test(name)) { groupKey = 'commands'; groupLabel = '命令'; itemLabel = args.toolSummary || args.CommandLine || name; }
  else if (/read_file|view_file|list_dir/.test(name)) { groupKey = 'reads'; groupLabel = '文件读取'; itemLabel = file || name; }
  else if (/write_file|edit_file|replace_file/.test(name)) { groupKey = 'edits'; groupLabel = '文件修改'; itemLabel = file || name; }
  else if (/search|find_by_name/.test(name)) { groupKey = 'searches'; groupLabel = '搜索'; itemLabel = args.query || args.Query || args.Pattern || name; }
  return { groupKey, groupLabel, itemLabel: String(itemLabel), detailTitle: args.CommandLine || path || JSON.stringify(args), toolName: name };
}

export function parseSessionData(requestedId, { includeSessions = true, strict = false, execution = null, appDataDir } = {}) {
  const dir = appDataDir || getAppDataDir();
  const conversationId = strict && !requestedId ? '' : resolveConversationId(requestedId, { appDataDir: dir });
  const sessions = includeSessions ? listRecentConversations({ appDataDir: dir }) : [];
  const steps = conversationId ? readLines(transcriptPath(conversationId, dir)) : [];
  const database = conversationId ? readDatabase(dir, conversationId) : null;
  const hookEvents = conversationId ? ['max-telemetry.jsonl', 'telemetry.jsonl', 'powertools-telemetry.jsonl'].flatMap(name => readLines(join(dir, 'brain', conversationId, '.system_generated', 'logs', name))) : [];
  const turns = [];
  let turn, modelName = '';
  let latestInput = 0, latestCache = 0, latestOutput = 0;
  let totalInput = 0, totalCache = 0, totalOutput = 0, orphanToolCount = 0;
  let modelTimeMs = 0, timedOutputTokens = 0, generationTimeMs = 0;
  const ttfts = [], toolIntervals = [], transcriptCheckpoints = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const timing = database?.times.get(step.step_index);
    const createdMs = timing?.createdMs ?? (step.created_at ? Date.parse(step.created_at) : null);
    const completedMs = timing?.completedMs ?? timing?.finishedMs ?? null;
    if (step.type === 'USER_INPUT') {
      if (/^Error: The stream was interrupted/i.test(step.content || '')) continue;
      const selected = (step.content || '').match(/changed setting `Model Selection` from .*? to ([^\n]+?)\./);
      if (selected) modelName = selected[1].trim();
      const prompt = cleanPrompt(step.content);
      turn = {
        turnNumber: turns.length + 1, stepIndexStart: step.step_index, stepIndexEnd: step.step_index,
        prompt, promptTitle: prompt.split('\n')[0].slice(0, 90),
        startedAtMs: createdMs, startedAtIso: iso(createdMs), completedAtMs: null, completedAtIso: null,
        durationMs: null, workedDurationMs: null, inputTokens: 0, cacheReadTokens: 0,
        outputTokens: 0, contextTokens: 0, stepCount: 0, toolCalls: [], toolGroups: [],
        assistantPreview: '', status: 'running'
      };
      turns.push(turn);
      continue;
    }
    if (turn) {
      turn.stepCount++;
      turn.stepIndexEnd = step.step_index;
      if (['PLANNER_RESPONSE', 'GENERIC', 'ERROR_MESSAGE', 'CHECKPOINT'].includes(step.type) && Number.isFinite(completedMs) && completedMs > (turn.completedAtMs || 0)) turn.completedAtMs = completedMs;
    }
    if (step.type === 'PLANNER_RESPONSE') {
      if (turn) turn.status = 'running';
      const input = number(step.input_tokens), cached = number(step.cache_read_tokens), output = number(step.output_tokens);
      totalInput += input; totalCache += cached; totalOutput += output;
      if (turn) {
        turn.inputTokens += input; turn.cacheReadTokens += cached; turn.outputTokens += output;
      }
      if (input + cached + output) {
        latestInput = input; latestCache = cached; latestOutput = output;
        if (turn) turn.contextTokens = input + cached;
      }
      if (turn && step.content) turn.assistantPreview = step.content.slice(0, 240);
      const duration = elapsed(createdMs, timing?.finishedMs ?? timing?.completedMs);
      const ttft = elapsed(createdMs, timing?.viewableMs);
      if (duration !== null && output > 0) {
        modelTimeMs += duration;
        const streamMs = elapsed(timing?.viewableMs, timing?.finishedMs);
        if (streamMs > 0) { timedOutputTokens += output; generationTimeMs += streamMs; }
        if (ttft !== null) ttfts.push(ttft);
      }
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      let hitToolBoundary = false;
      for (let c = 0; c < calls.length; c++) {
        const candidate = hitToolBoundary ? null : steps[i + 1 + c];
        if (!candidate || candidate.type === 'USER_INPUT' || candidate.type === 'PLANNER_RESPONSE') hitToolBoundary = true;
        const result = !hitToolBoundary && candidate?.type === 'GENERIC' ? candidate : null;
        const content = result ? result.content || '' : '';
        const resultTiming = result ? database?.times.get(result.step_index) : null;
        const matchTime = label => { const m = content.match(new RegExp(`${label}:\\s*([^\\r\\n]+)`)); return m ? Date.parse(m[1]) : null; };
        const start = resultTiming?.startedMs ?? matchTime('Created At');
        const end = resultTiming?.completedMs ?? matchTime('Completed At');
        const durationMs = elapsed(start, end);
        if (durationMs !== null) toolIntervals.push([start, end]);
        if (turn) {
          if (Number.isFinite(end) && end > (turn.completedAtMs || 0)) turn.completedAtMs = end;
          turn.toolCalls.push({
            id: `step-${step.step_index}-tool-${c}`, stepIndex: step.step_index, ...classify(calls[c]),
            startedAtIso: iso(start), completedAtIso: iso(end), durationMs,
            outputPreview: content.replace(/^(Created At|Completed At):[^\r\n]*[\r\n]+/gm, '').slice(0, 1600)
          });
        } else {
          orphanToolCount++;
        }
      }
      if (turn && !calls.length && step.content) turn.status = 'complete';
    }
    if (turn && step.type === 'ERROR_MESSAGE') turn.status = 'error';
    if (step.type === 'CHECKPOINT') {
      const summaryTokens = number(step.output_tokens) || Math.ceil((step.content || '').length / 4);
      if (Number.isInteger(step.step_index)) transcriptCheckpoints.push({ stepIndex: step.step_index, summaryTokens });
      latestInput = summaryTokens; latestCache = 0; latestOutput = 0;
      if (turn) {
        turn.contextTokens = summaryTokens;
        if (!turn.assistantPreview && step.content) turn.assistantPreview = step.content.slice(0, 240);
        turn.status = 'complete';
      }
    }
  }
  let matchedLiveLast = false;
  if (turns.length) {
    const resolvedLast = resolveTurnExecution(turns.at(-1), execution, conversationId, steps);
    matchedLiveLast = resolvedLast !== turns.at(-1);
    turns[turns.length - 1] = resolvedLast;
  }
  const dbExecutions = Array.isArray(database?.executions) ? database.executions : [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if ((i < turns.length - 1 || !matchedLiveLast) && dbExecutions.length) {
      const nextStart = i + 1 < turns.length ? turns[i + 1].stepIndexStart : Infinity;
      const maxTurnStep = i === turns.length - 1 ? (steps.at(-1)?.step_index ?? t.stepIndexEnd) : t.stepIndexEnd;
      const persisted = [...dbExecutions].reverse().find(e =>
        Number.isInteger(e?.stepIndex) && e.stepIndex >= t.stepIndexStart && e.stepIndex < nextStart && e.stepIndex >= maxTurnStep
      );
      if (persisted) {
        const r = persisted.terminationReason;
        if (r === 2) t.status = 'stopped';
        else if ([1, 3, 6, 11].includes(r)) t.status = 'error';
        else if ([4, 8, 9, 10].includes(r) && t.status === 'running') t.status = 'complete';
      }
    }
    if (i < turns.length - 1 && t.status === 'running') t.status = 'stopped';
    t.completedAtIso = iso(t.completedAtMs);
    t.durationMs = elapsed(t.startedAtMs, t.completedAtMs);
    t.workedDurationMs = t.durationMs;
    const groups = new Map();
    for (const call of t.toolCalls) {
      if (!groups.has(call.groupKey)) groups.set(call.groupKey, { groupKey: call.groupKey, groupLabel: call.groupLabel, items: [] });
      groups.get(call.groupKey).items.push(call);
    }
    t.toolGroups = [...groups.values()];
  }
  let toolTimeMs = 0, interval = null;
  for (const next of toolIntervals.sort((a, b) => a[0] - b[0])) {
    if (!interval || next[0] > interval[1]) { if (interval) toolTimeMs += interval[1] - interval[0]; interval = [...next]; }
    else interval[1] = Math.max(interval[1], next[1]);
  }
  if (interval) toolTimeMs += interval[1] - interval[0];
  const rawLatestGen = database?.generations.filter(g => g.context || g.providerInputTokens > 0).at(-1);
  const cpMap = new Map();
  for (const cp of database?.checkpoints || []) cpMap.set(cp.stepIndex, cp.summaryTokens || 0);
  for (const idx of database?.checkpointSteps || []) if (!cpMap.has(idx)) cpMap.set(idx, 0);
  for (const cp of transcriptCheckpoints) if (!cpMap.get(cp.stepIndex)) cpMap.set(cp.stepIndex, cp.summaryTokens || 0);
  const checkpoints = [...cpMap.entries()].sort((a, b) => a[0] - b[0]).map(([stepIndex, summaryTokens]) => ({ stepIndex, summaryTokens }));
  const checkpointSteps = checkpoints.map(c => c.stepIndex);
  const latestGen = compactGeneration(rawLatestGen, database?.generations || [], checkpoints);
  if (latestGen?.modelName) modelName = latestGen.modelName;
  // Provider completion timings are persisted with each generation.
  const timed = database?.generations.filter(g => g.outputTokens > 0 && g.streamingMs > 0 && g.ttftMs !== null) || [];
  if (timed.length) {
    modelTimeMs = timed.reduce((n, g) => n + g.ttftMs + g.streamingMs, 0);
    generationTimeMs = timed.reduce((n, g) => n + g.streamingMs, 0);
    timedOutputTokens = timed.reduce((n, g) => n + g.outputTokens, 0);
    ttfts.splice(0, ttfts.length, ...timed.map(g => g.ttftMs));
  }
  const context = contextSnapshot(latestGen, latestInput + latestCache);
  const multiModel = modelContexts(database?.generations || [], checkpointSteps, checkpoints);
  const requests = requestEvents(database, conversationId);
  if (totalInput + totalCache + totalOutput === 0 && requests.length > 0) {
    for (const r of requests) {
      totalInput += number(r.inputTokens);
      totalCache += number(r.cacheReadTokens);
      totalOutput += number(r.outputTokens);
    }
  }
  const totalInputAndCache = totalInput + totalCache;
  const errors = steps.filter(s => s.type === 'ERROR_MESSAGE').map(s => ({ id: `step-${s.step_index}`, timestampMs: database?.times.get(s.step_index)?.createdMs ?? Date.parse(s.created_at), message: s.content || '', stepIndex: s.step_index }));
  const failedRequests = requests.filter(r => r.error);
  const failedGens = (database?.generations || []).filter(g => g.error);
  const normErr = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const matchedErrorIndices = new Set();
  let extraRequestErrors = 0;
  for (let idx = 0; idx < failedRequests.length; idx++) {
    const req = failedRequests[idx];
    const gen = failedGens[idx];
    const reqMsg = normErr(req.error);
    const stepSet = Array.isArray(gen?.stepIndices) ? new Set(gen.stepIndices) : null;
    const matchIdx = errors.findIndex((err, errIdx) => {
      if (matchedErrorIndices.has(errIdx)) return false;
      if (stepSet && Number.isInteger(err.stepIndex) && (stepSet.has(err.stepIndex) || stepSet.has(err.stepIndex - 1))) return true;
      const errMsg = normErr(err.message);
      const dt = Number.isFinite(err.timestampMs) && Number.isFinite(req.timestampMs) ? Math.abs(err.timestampMs - req.timestampMs) : null;
      if (errMsg && reqMsg && (errMsg === reqMsg || errMsg.includes(reqMsg) || reqMsg.includes(errMsg))) {
        return dt === null || dt <= 15000;
      }
      return dt !== null && dt <= 5000;
    });
    if (matchIdx >= 0) matchedErrorIndices.add(matchIdx);
    else extraRequestErrors++;
  }
  const errorCount = errors.length + extraRequestErrors;
  const speeds = requests.map(r => r.tps).filter(Number.isFinite);
  const completeRequests = requests.filter(r => r.tps != null && r.outputTokens > 0);
  const requestDuration = completeRequests.reduce((sum, r) => sum + (r.effectiveGenMs ?? r.durationMs ?? 0), 0);
  return {
    conversationId, sessions, modelName: modelName || '未知模型', hookEventsCount: hookEvents.length,
    contextWindow: {
      ...context,
      ...multiModel,
      inputTokens: latestGen?.inputTokens ?? latestInput,
      cacheReadTokens: latestGen?.cacheReadTokens ?? latestCache,
      outputTokens: latestGen?.outputTokens ?? latestOutput
    },
    telemetry: {
      turnCount: turns.length, stepCount: steps.length,
      modelTimeMs: modelTimeMs || null, toolTimeMs: toolIntervals.length ? toolTimeMs : null,
      avgTtftMs: ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null,
      tps: requestDuration > 0 ? Number((completeRequests.reduce((sum, r) => sum + r.outputTokens, 0) * 1000 / requestDuration).toFixed(1)) : null,
      peakTps: speeds.length ? Math.max(...speeds) : null,
      latestTps: speeds.at(-1) ?? null, requestCount: requests.length, errorCount,
      thinkingTokens: requests.reduce((n, r) => n + r.thinkingTokens, 0),
      toolCount: turns.reduce((n, t) => n + t.toolCalls.length, 0) + orphanToolCount,
      timedOutputTokens, generationTimeMs: generationTimeMs || null,
      totalTokens: totalInputAndCache + totalOutput, inputTokens: totalInput,
      cacheReadTokens: totalCache, outputTokens: totalOutput,
      cacheHitPercent: totalInputAndCache > 0 ? Number((totalCache / totalInputAndCache * 100).toFixed(1)) : null
    }, turns, executions: dbExecutions, requests, errors, transcriptGoal: extractTranscriptGoal(steps, database), progress: readProgress(dir, conversationId, turns, steps, Date.now(), database, execution)
  };
}

export function exportTranscript(conversationId, targetTurnNumber, { appDataDir } = {}) {
  const dir = appDataDir || getAppDataDir();
  if (!validId(conversationId) || !existsSync(transcriptPath(conversationId, dir))) throw new Error('找不到源会话');
  const data = parseSessionData(conversationId, { includeSessions: false, appDataDir: dir });
  const turnNumber = targetTurnNumber ?? data.turns.length;
  if (!Number.isInteger(turnNumber) || turnNumber < 1 || turnNumber > data.turns.length) throw new Error('轮次不存在');
  const next = data.turns[turnNumber];
  const steps = readLines(transcriptPath(conversationId, dir)).filter(s => !next || s.step_index < next.stepIndexStart);
  const lines = ['# 会话上下文', `源会话: ${conversationId}`, `截至轮次: ${turnNumber}`, ''];
  for (const step of steps) {
    if (step.type === 'USER_INPUT') lines.push('## 用户', cleanPrompt(step.content), '');
    else if (step.type === 'PLANNER_RESPONSE') {
      if (step.content) lines.push('## 助手', step.content, '');
      if (step.tool_calls?.length) lines.push('## 工具调用', JSON.stringify(step.tool_calls, null, 2), '');
    } else if (step.type === 'GENERIC' || step.type === 'ERROR_MESSAGE') lines.push(`## ${step.type === 'GENERIC' ? '工具结果' : '错误'}`, step.content || '', '');
  }
  const markdownTranscript = lines.join('\n');
  const scratchDir = join(dir, 'brain', conversationId, 'scratch');
  mkdirSync(scratchDir, { recursive: true });
  const stem = `branch-turn-${turnNumber}-${randomUUID()}`;
  const snapshotPath = join(scratchDir, `${stem}.md`), rawSnapshotPath = join(scratchDir, `${stem}.jsonl`);
  writeFileSync(snapshotPath, markdownTranscript, 'utf8');
  writeFileSync(rawSnapshotPath, steps.map(s => JSON.stringify(s)).join('\n') + '\n', 'utf8');
  return {
    snapshotPath, rawSnapshotPath, markdownTranscript,
    turnNumber
  };
}

function hydrateTruncatedSteps(steps, fullFilePath, maxFullBytes = 64 * 1024 * 1024) {
  if (!steps.some(s => Array.isArray(s?.truncated_fields) && s.truncated_fields.length > 0)) return steps;
  try {
    if (!existsSync(fullFilePath)) return steps;
    const st = statSync(fullFilePath);
    if (!st.isFile() || st.size <= 0 || st.size > maxFullBytes) return steps;
    const byStepIndex = new Map();
    for (const line of readFileSync(fullFilePath, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (Number.isInteger(parsed?.step_index)) {
          byStepIndex.set(parsed.step_index, parsed);
        }
      } catch {}
    }
    return steps.map(step => {
      if (Array.isArray(step?.truncated_fields) && step.truncated_fields.length > 0 && byStepIndex.has(step.step_index)) {
        const full = byStepIndex.get(step.step_index);
        return {
          ...step,
          ...(typeof full.content === 'string' ? { content: full.content } : {}),
          ...(Array.isArray(full.tool_calls) ? { tool_calls: full.tool_calls } : {}),
          ...(typeof full.thinking === 'string' ? { thinking: full.thinking } : {})
        };
      }
      return step;
    });
  } catch {
    return steps;
  }
}

function fenceFor(text) {
  let maxTicks = 2;
  const matches = String(text || '').match(/`+/g);
  if (matches) {
    for (const m of matches) if (m.length > maxTicks) maxTicks = m.length;
  }
  return '`'.repeat(maxTicks + 1);
}

function normalizeToolCallArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object') return {};
  return Object.fromEntries(Object.entries(rawArgs).map(([key, value]) => {
    if (typeof value === 'string' && (value.startsWith('"') || value.startsWith('{') || value.startsWith('['))) {
      try { value = JSON.parse(value); } catch {}
    }
    return [key, value];
  }));
}

function escapeHtmlSummary(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatConversationMarkdown(conversationId, { upToTurn = null, title = '', language = 'zh-CN', maxChars = 8 * 1024 * 1024, appDataDir } = {}) {
  const dir = appDataDir || getAppDataDir();
  const txFile = transcriptPath(conversationId, dir);
  if (!validId(conversationId) || !existsSync(txFile)) throw new Error('找不到对应会话记录');

  const rawSteps = readLines(txFile);
  const fullPath = join(dir, 'brain', conversationId, '.system_generated', 'logs', 'transcript_full.jsonl');
  const steps = hydrateTruncatedSteps(rawSteps, fullPath);

  const turns = [];
  let cur = null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== 'object') continue;
    if (step.type === 'USER_INPUT') {
      if (/^Error: The stream was interrupted/i.test(step.content || '')) continue;
      const prompt = cleanPrompt(step.content);
      cur = {
        turnNumber: turns.length + 1,
        prompt,
        media: Array.isArray(step.media) ? step.media : [],
        createdAt: step.created_at || '',
        stepEntries: []
      };
      turns.push(cur);
      continue;
    }
    if (cur) cur.stepEntries.push({ step, index: i });
  }

  if (!turns.length) throw new Error('该会话暂无可复制的对话内容');
  const targetTurn = upToTurn == null ? turns.length : Number(upToTurn);
  if (!Number.isInteger(targetTurn) || targetTurn < 1 || targetTurn > turns.length) {
    throw new Error('指定的轮次超出范围');
  }

  const sliceTurns = turns.slice(0, targetTurn);
  const en = language === 'en';
  const resolvedTitle = String(title || '').trim() || sliceTurns[0]?.prompt?.split('\n')[0]?.slice(0, 80) || (en ? 'Conversation' : '会话记录');
  const userHeading = en ? 'User' : '用户';
  const assistantHeading = en ? 'Assistant' : '助手';
  const out = [`# ${resolvedTitle}`, ''];

  for (const t of sliceTurns) {
    out.push(`## ${userHeading} (#${t.turnNumber})`, '', t.prompt, '');
    if (t.media.length > 0) {
      for (const m of t.media) {
        const uri = String(m?.uri || '').trim();
        const mime = String(m?.mime_type || m?.mimeType || 'media').trim();
        if (uri) out.push(`- ${en ? 'Attachment' : '附件'} (\`${mime}\`): \`${uri}\``);
      }
      out.push('');
    }

    const blocks = [];
    const consumedGeneric = new Set();
    const turnSteps = t.stepEntries;

    for (let idx = 0; idx < turnSteps.length; idx++) {
      const { step } = turnSteps[idx];
      if (step.type === 'PLANNER_RESPONSE') {
        const cleaned = String(step.content || '')
          .replace(/<!--\s*GOAL_(?:COMPLETE|CANCELLED)\s*-->/g, '')
          .trim();
        if (cleaned) blocks.push(cleaned);

        const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        for (let c = 0; c < calls.length; c++) {
          const call = calls[c];
          const info = classify(call);
          const parsedArgs = normalizeToolCallArgs(call?.args);
          const nextEntry = turnSteps[idx + 1 + c];
          let resultContent = '';
          if (nextEntry && nextEntry.step?.type === 'GENERIC' && !consumedGeneric.has(idx + 1 + c)) {
            consumedGeneric.add(idx + 1 + c);
            resultContent = String(nextEntry.step.content || '').trim();
          }
          const shortLabel = String(info.itemLabel || '').replace(/\r?\n/g, ' ').trim().slice(0, 120);
          const summaryTitle = shortLabel && shortLabel !== info.toolName
            ? `${en ? 'Tool call' : '工具调用'}: <code>${escapeHtmlSummary(info.toolName)}</code> — ${escapeHtmlSummary(shortLabel)}`
            : `${en ? 'Tool call' : '工具调用'}: <code>${escapeHtmlSummary(info.toolName)}</code>`;
          const detailLines = ['<details>', `<summary>${summaryTitle}</summary>`, ''];
          if (Object.keys(parsedArgs).length > 0) {
            const argsJson = JSON.stringify(parsedArgs, null, 2);
            const argFence = fenceFor(argsJson);
            detailLines.push(`**${en ? 'Arguments' : '参数'}**`, '', `${argFence}json`, argsJson, argFence, '');
          }
          if (resultContent) {
            const resFence = fenceFor(resultContent);
            detailLines.push(`**${en ? 'Output' : '结果'}**`, '', `${resFence}text`, resultContent, resFence, '');
          }
          detailLines.push('</details>');
          blocks.push(detailLines.join('\n'));
        }
      } else if (step.type === 'GENERIC' && !consumedGeneric.has(idx)) {
        const resultText = String(step.content || '').trim();
        if (resultText) {
          const resFence = fenceFor(resultText);
          blocks.push([
            '<details>',
            `<summary>${en ? 'Tool output' : '工具结果'}</summary>`,
            '',
            `${resFence}text`,
            resultText,
            resFence,
            '',
            '</details>'
          ].join('\n'));
        }
      } else if (step.type === 'SYSTEM_MESSAGE') {
        const sysText = String(step.content || '').trim();
        if (sysText) {
          const sysFence = fenceFor(sysText);
          blocks.push([
            '<details>',
            `<summary>${en ? 'System notification' : '系统消息'}</summary>`,
            '',
            `${sysFence}text`,
            sysText,
            sysFence,
            '',
            '</details>'
          ].join('\n'));
        }
      } else if (step.type === 'ERROR_MESSAGE' && step.content) {
        blocks.push(`> **${en ? 'Error' : '错误'}**: ${String(step.content).trim()}`);
      }
    }

    if (blocks.length > 0) {
      out.push(`## ${assistantHeading}`, '', blocks.join('\n\n'), '');
    }
    out.push('---', '');
  }
  if (out.at(-2) === '---') out.splice(-2, 2);

  let markdown = out.join('\n').trim() + '\n';
  let truncated = false;
  if (markdown.length > maxChars) {
    markdown = markdown.slice(0, maxChars) + `\n\n<!-- ${en ? 'Truncated due to size limit' : '内容过长已截断'} -->\n`;
    truncated = true;
  }
  return {
    ok: true,
    conversationId,
    turnCount: sliceTurns.length,
    totalTurns: turns.length,
    truncated,
    markdown
  };
}
