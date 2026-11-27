import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { parseSessionData, exportTranscript, resolveConversationId } from '../sidecars/inspector/main.mjs';
import { formatConversationMarkdown } from '../lib/session-parser.mjs';
import { decodeGeneration } from '../lib/database.mjs';
import { fields } from '../lib/protobuf.mjs';
import { isHubTarget, findIdentifier } from '../lib/native-host.mjs';

const varint = value => { const a=[]; let n=BigInt(value); do { let b=Number(n&127n); n>>=7n; if(n)b|=128; a.push(b); } while(n); return Buffer.from(a); };
const integer = (n,value) => Buffer.concat([varint(n*8),varint(value)]);
const bytes = (n,value) => { const b=Buffer.from(value); return Buffer.concat([varint(n*8+2),varint(b.length),b]); };
const concat = (...parts) => Buffer.concat(parts);
const duration = seconds => concat(integer(1,seconds));
const timestamp = seconds => concat(integer(1,seconds));
const context = concat(integer(1,48000),integer(4,200000),bytes(3,bytes(1,concat(bytes(1,'System Prompt'),integer(4,6000)))));
const generation = bytes(1,concat(bytes(4,concat(integer(2,500),integer(3,100),integer(5,1500))),bytes(9,bytes(10,context)),bytes(11,duration(2)),bytes(12,duration(5)),bytes(19,'fixture-model')));

test('reads provider timings and actual context capacity from protobuf',()=>{
  const g=decodeGeneration(generation);
  assert.equal(g.providerInputTokens,2000);assert.equal(g.context.maxTokens,200000);assert.equal(g.context.usedTokens,48000);
  assert.equal(g.ttftMs,2000);assert.equal(g.streamingMs,5000);assert.equal(g.outputTokens,100);
  assert.equal(g.context.categories[0].tokens,6000);
  assert.throws(()=>fields(Buffer.from([10,8,1])),/Truncated/);
});

test('real database metrics, complete branch boundary, invalid IDs and transcript fallback',()=>{
  const root=mkdtempSync(join(tmpdir(),'agy-test-'));const previous=process.env.ANTIGRAVITY_APP_DATA_DIR;
  process.env.ANTIGRAVITY_APP_DATA_DIR=root;
  try{
    const logs=join(root,'brain','fixture','.system_generated','logs');mkdirSync(logs,{recursive:true});mkdirSync(join(root,'conversations'));
    const longResponse='assistant-'.repeat(100)+'RESPONSE_END';const longOutput='result-'.repeat(300)+'OUTPUT_END';
    const steps=[
      {step_index:0,type:'USER_INPUT',created_at:'2025-01-01T00:00:00Z',content:'<USER_REQUEST>first</USER_REQUEST>'},
      {step_index:1,type:'PLANNER_RESPONSE',created_at:'2025-01-01T00:00:01Z',input_tokens:500,cache_read_tokens:1500,output_tokens:100,content:longResponse,tool_calls:[{name:'run_command',args:{CommandLine:'echo fixture'}}]},
      {step_index:2,type:'GENERIC',created_at:'2025-01-01T00:00:08Z',content:longOutput},
      {step_index:3,type:'USER_INPUT',created_at:'2025-01-01T00:00:10Z',content:'second secret request'},
      {step_index:4,type:'PLANNER_RESPONSE',created_at:'2025-01-01T00:00:11Z',content:'second reply'}
    ];
    writeFileSync(join(logs,'transcript.jsonl'),steps.map(s=>JSON.stringify(s)).join('\n')+'\n{"partial":');
    const dbPath=join(root,'conversations','fixture.db');const db=new DatabaseSync(dbPath);
    db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY,metadata BLOB);');
    db.prepare('INSERT INTO gen_metadata VALUES (?,?)').run(0,generation);
    db.prepare('INSERT INTO steps VALUES (?,?)').run(1,concat(bytes(1,timestamp(1735689601)),bytes(6,timestamp(1735689603)),bytes(7,timestamp(1735689608)),bytes(8,timestamp(1735689608))));db.close();
    const before=readFileSync(dbPath);const state=parseSessionData('fixture',{includeSessions:false});
    assert.equal(state.telemetry.tps,20);assert.equal(state.telemetry.avgTtftMs,2000);assert.equal(state.telemetry.cacheHitPercent,75);
    assert.equal(state.contextWindow.maxTokens,200000);assert.equal(state.contextWindow.usedPercent,1);
    assert.equal(state.turns[0].durationMs,8000);assert.deepEqual(readFileSync(dbPath),before);
    const branch=exportTranscript('fixture',1);
    assert.ok(branch.markdownTranscript.includes(longResponse));assert.ok(branch.markdownTranscript.includes(longOutput));
    assert.ok(!branch.markdownTranscript.includes('second secret request'));
    assert.deepEqual(readFileSync(branch.rawSnapshotPath,'utf8').trim().split('\n').map(JSON.parse),steps.slice(0,3));
    assert.throws(()=>exportTranscript('fixture',3),/轮次/);assert.throws(()=>exportTranscript('../fixture',1),/源会话/);
    assert.equal(resolveConversationId('../fixture'),'');assert.equal(parseSessionData('missing').turns.length,0);
    assert.equal(parseSessionData('',{strict:true}).conversationId,'');
    const fallbackLogs=join(root,'brain','fallback','.system_generated','logs');mkdirSync(fallbackLogs,{recursive:true});writeFileSync(join(fallbackLogs,'transcript.jsonl'),steps.map(s=>JSON.stringify(s)).join('\n'));
    const fallback=parseSessionData('fallback');assert.equal(fallback.telemetry.tps,null);assert.equal(fallback.telemetry.avgTtftMs,null);assert.equal(fallback.contextWindow.maxTokens,null);
    assert.equal(fallback.turns[1].completedAtIso,null);assert.equal(fallback.turns[1].durationMs,null);
  }finally{if(previous===undefined)delete process.env.ANTIGRAVITY_APP_DATA_DIR;else process.env.ANTIGRAVITY_APP_DATA_DIR=previous;rmSync(root,{recursive:true,force:true});}
});

test('hooks stay valid and data-only, including inherited sidecar environment',()=>{
  const result=spawnSync(process.execPath,['scripts/telemetry-hook.mjs','PreInvocation'],{input:JSON.stringify({invocationNum:0}),encoding:'utf8',env:{...process.env,ANTIGRAVITY_SIDECAR_WEB_PORT:'9999'}});
  assert.equal(result.status,0);assert.deepEqual(JSON.parse(result.stdout),{});assert.equal(result.stderr,'');
});

test('a retried request does not fail a running turn, and genuine termination remains visible',()=>{
  const root=mkdtempSync(join(tmpdir(),'agy-retry-')),previous=process.env.ANTIGRAVITY_APP_DATA_DIR;
  process.env.ANTIGRAVITY_APP_DATA_DIR=root;
  try{
    const logs=join(root,'brain','retry','.system_generated','logs');mkdirSync(logs,{recursive:true});
    const path=join(logs,'transcript.jsonl'),steps=[{step_index:0,type:'USER_INPUT',content:'Read files',created_at:'2026-11-16T00:00:00Z'},{step_index:1,type:'ERROR_MESSAGE',content:'stream interrupted'}];
    const save=()=>writeFileSync(path,steps.map(s=>JSON.stringify(s)).join('\n'));
    const options={includeSessions:false,strict:true,execution:{conversationId:'retry',turnStartStepIndex:0,status:2,terminationReason:0}};
    save();let state=parseSessionData('retry',options);assert.equal(state.progress.status,'running');assert.equal(state.turns[0].status,'running');assert.equal(state.errors.length,1);
    assert.equal(parseSessionData('retry',{...options,execution:{...options.execution,status:1,terminationReason:1}}).progress.status,'error');
    steps.push({step_index:2,type:'PLANNER_RESPONSE',content:'Reading next file',tool_calls:[{name:'read_file',args:{Path:'fixture.md'}}]},{step_index:3,type:'GENERIC',content:'file result'});save();
    assert.equal(parseSessionData('retry',{includeSessions:false}).progress.status,'running');
    assert.equal(parseSessionData('retry',options).errors.length,1);
    steps.push({step_index:4,type:'PLANNER_RESPONSE',content:'Intermediate update'});save();
    assert.equal(parseSessionData('retry',options).progress.status,'running');
    assert.equal(parseSessionData('retry',{...options,execution:{...options.execution,status:1,terminationReason:4}}).progress.status,'complete');
    assert.equal(parseSessionData('retry',{...options,execution:{...options.execution,status:1,terminationReason:2}}).progress.status,'stopped');
    assert.equal(parseSessionData('retry',{...options,execution:{...options.execution,status:2,turnStartStepIndex:99}}).progress.status,'complete');
  }finally{if(previous===undefined)delete process.env.ANTIGRAVITY_APP_DATA_DIR;else process.env.ANTIGRAVITY_APP_DATA_DIR=previous;rmSync(root,{recursive:true,force:true});}
});

test('native integration follows conversation titles and excludes external pages and iframes',()=>{
  assert.ok(isHubTarget({type:'page',title:'Antigravity',url:'https://127.0.0.1:1234/'}));
  assert.ok(isHubTarget({type:'page',title:'(3) Antigravity',url:'https://127.0.0.1:1234/powertools'}));
  assert.ok(isHubTarget({type:'page',title:'Conversation - Project - Antigravity',url:'https://127.0.0.1:1234/c/fixture'}));
  assert.ok(isHubTarget({type:'page',title:'(2) Conversation - Project - Antigravity',url:'https://127.0.0.1:1234/c/fixture'}));
  assert.ok(isHubTarget({type:'page',title:'Antigravity (SSH: prod-box)',url:'https://127.0.0.1:1234/'}));
  assert.ok(isHubTarget({type:'page',title:'Conversation - Project - Antigravity (SSH: prod-box)',url:'https://127.0.0.1:1234/c/fixture'}));
  assert.ok(isHubTarget({type:'page',title:'Conversation - Project - Antigravity [SSH: prod-box]',url:'https://127.0.0.1:1234/c/fixture'}));
  assert.ok(!isHubTarget({type:'page',title:'Antigravity Docs',url:'https://127.0.0.1:1234/'}));
  assert.ok(!isHubTarget({type:'page',title:'Antigravity',url:'https://example.com/'}));
  assert.ok(!isHubTarget({type:'iframe',title:'Antigravity',url:'https://127.0.0.1:1234/'}));
  assert.equal(findIdentifier({events:[{response:{conversationId:'new-id'}}]}),'new-id');
  assert.equal(findIdentifier({events:[{metadata:{projectId:'source-project'}}]},['projectId']),'source-project');
});

test('formatConversationMarkdown cleans system tags, hydrates truncated content from transcript_full.jsonl, and supports upToTurn', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-md-'));
  try {
    const logs = join(root, 'brain', 'md-conv', '.system_generated', 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'transcript.jsonl'), [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\n实现缓存清理脚本\n</USER_REQUEST>\n<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>' }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'truncated...', truncated_fields: ['content', 'tool_calls'], tool_calls: [{ name: 'run_command', args: { CommandLine: '"rm..."' } }] }),
      JSON.stringify({ step_index: 2, type: 'GENERIC', content: 'short out...', truncated_fields: ['content'] }),
      JSON.stringify({ step_index: 3, type: 'USER_INPUT', content: '<USER_REQUEST>\n再加个单元测试\n</USER_REQUEST>' }),
      JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', content: '单测已补齐！\n<!-- GOAL_COMPLETE -->' })
    ].join('\n') + '\n');
    writeFileSync(join(logs, 'transcript_full.jsonl'), [
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: '完整长回复内容：先清理构建缓存', tool_calls: [{ name: 'run_command', args: { CommandLine: '"rm -rf .cache/full-dir"', WaitMsBeforeAsync: '5000' } }] }),
      JSON.stringify({ step_index: 2, type: 'GENERIC', content: 'Command exited with code 0.\n\nCommand output:\nRemoved 42 cached files including ```nested``` snippet' })
    ].join('\n') + '\n');

    const full = formatConversationMarkdown('md-conv', { appDataDir: root, title: '自定义标题' });
    assert.equal(full.turnCount, 2);
    assert.match(full.markdown, /^# 自定义标题\n/);
    assert.ok(full.markdown.includes('完整长回复内容：先清理构建缓存'));
    assert.ok(full.markdown.includes('rm -rf .cache/full-dir'));
    assert.ok(full.markdown.includes('Removed 42 cached files including ```nested``` snippet'));
    assert.ok(full.markdown.includes('````text'));
    assert.ok(!full.markdown.includes('ADDITIONAL_METADATA'));
    assert.ok(!full.markdown.includes('GOAL_COMPLETE'));

    const turn1 = formatConversationMarkdown('md-conv', { appDataDir: root, upToTurn: 1 });
    assert.equal(turn1.turnCount, 1);
    assert.ok(!turn1.markdown.includes('再加个单元测试'));
    assert.throws(() => formatConversationMarkdown('../bad', { appDataDir: root }), /找不到/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseSessionData updates context tokens and percentage immediately after /compact CHECKPOINT before next turn', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-compact-'));
  try {
    const logs = join(root, 'brain', 'compact-conv', '.system_generated', 'logs');
    mkdirSync(logs, { recursive: true });
    mkdirSync(join(root, 'conversations'), { recursive: true });
    const steps = [
      { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-25T01:00:00Z', content: '<USER_REQUEST>explain compaction</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-25T01:05:00Z', input_tokens: 2997, cache_read_tokens: 84981, output_tokens: 4327, content: 'Detailed reply' },
      { step_index: 2, type: 'USER_INPUT', created_at: '2026-11-25T01:08:00Z', content: '<USER_REQUEST>/compact</USER_REQUEST>' },
      { step_index: 3, type: 'CHECKPOINT', created_at: '2026-11-25T01:08:16Z', input_tokens: 93213, cache_read_tokens: 0, output_tokens: 2837, content: '# Resuming from a compaction\n<summary>short summary</summary>' }
    ];
    writeFileSync(join(logs, 'transcript.jsonl'), steps.map(s => JSON.stringify(s)).join('\n') + '\n');

    const preCategories = concat(
      bytes(1, concat(bytes(1, 'System Prompt'), integer(4, 15000))),
      bytes(1, concat(bytes(1, 'Tools'), integer(4, 28032))),
      bytes(1, concat(bytes(1, 'Chat Messages'), integer(4, 56291)))
    );
    const preContext = concat(integer(1, 99323), integer(4, 786432), bytes(3, preCategories));
    const preGen = concat(
      integer(2, 1),
      bytes(1, concat(
        bytes(4, concat(integer(2, 2997), integer(3, 4327), integer(5, 84981))),
        bytes(9, bytes(10, preContext)),
        bytes(21, 'Gemini 4 Carbon (High)')
      ))
    );
    const cpMetadata = concat(
      bytes(1, timestamp(1795540096)),
      bytes(8, timestamp(1795540152)),
      bytes(9, concat(integer(2, 93213), integer(3, 2837), integer(9, 89), integer(10, 2748)))
    );
    const dbPath = join(root, 'conversations', 'compact-conv.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);');
    db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, preGen);
    db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(3, 23, cpMetadata);
    db.close();

    const state = parseSessionData('compact-conv', { includeSessions: false, appDataDir: root });
    assert.equal(state.contextWindow.compactions, 1);
    assert.equal(state.contextWindow.usedTokens, 34435);
    assert.equal(state.contextWindow.usedPercent, 4.4);
    assert.equal(state.contextWindow.inputTokens, 0);
    assert.equal(state.contextWindow.cacheReadTokens, 0);
    assert.equal(state.turns.at(-1).status, 'complete');

    const fallbackLogs = join(root, 'brain', 'compact-fallback', '.system_generated', 'logs');
    mkdirSync(fallbackLogs, { recursive: true });
    writeFileSync(join(fallbackLogs, 'transcript.jsonl'), steps.map(s => JSON.stringify(s)).join('\n') + '\n');
    const fallbackState = parseSessionData('compact-fallback', { includeSessions: false, appDataDir: root });
    assert.equal(fallbackState.contextWindow.compactions, 1);
    assert.equal(fallbackState.contextWindow.usedTokens, 2837);
    assert.equal(fallbackState.contextWindow.cacheReadTokens, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseSessionData reads max-telemetry.jsonl, gates interrupted tool resultTiming to GENERIC within turn, and deduplicates errorCount', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-session-fix-'));
  const previous = process.env.ANTIGRAVITY_APP_DATA_DIR;
  process.env.ANTIGRAVITY_APP_DATA_DIR = root;
  try {
    const logs = join(root, 'brain', 'sess-fix', '.system_generated', 'logs');
    mkdirSync(logs, { recursive: true });
    mkdirSync(join(root, 'conversations'), { recursive: true });

    writeFileSync(join(logs, 'max-telemetry.jsonl'), [
      JSON.stringify({ pluginId: 'agy-max', event: 'PreInvocation', ts: 1735689600000 }),
      JSON.stringify({ pluginId: 'agy-max', event: 'PostInvocation', ts: 1735689605000 })
    ].join('\n') + '\n');

    const steps = [
      { step_index: 0, type: 'USER_INPUT', created_at: '2025-01-01T00:00:00Z', content: '<USER_REQUEST>turn 1</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2025-01-01T00:00:01Z',
        content: 'running interrupted tools',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'sleep 99' } },
          { name: 'read_file', args: { Path: 'a.txt' } }
        ]
      },
      // Interrupted: NO GENERIC result for turn 1's tools; next step is USER_INPUT for turn 2!
      { step_index: 2, type: 'USER_INPUT', created_at: '2025-01-01T00:01:00Z', content: '<USER_REQUEST>turn 2</USER_REQUEST>' },
      { step_index: 3, type: 'GENERIC', created_at: '2025-01-01T00:01:05Z', content: 'Created At: 2025-01-01T00:01:05Z\nCompleted At: 2025-01-01T00:01:10Z\nunrelated later generic' },
      { step_index: 4, type: 'ERROR_MESSAGE', created_at: '2025-01-01T00:01:12Z', content: 'upstream timeout' }
    ];
    writeFileSync(join(logs, 'transcript.jsonl'), steps.map(s => JSON.stringify(s)).join('\n') + '\n');

    const dbPath = join(root, 'conversations', 'sess-fix.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY,metadata BLOB);');
    // Failed generation matching step 4 ('upstream timeout') + a distinct separate failed generation at step 10
    const failedGen1 = concat(bytes(1, bytes(19, 'Gemini 4 Neon')), integer(2, 4), bytes(5, 'upstream timeout'));
    const failedGen2 = concat(bytes(1, bytes(19, 'Gemini 4 Neon')), integer(2, 10), bytes(5, 'rate limited'));
    db.prepare('INSERT INTO gen_metadata VALUES (?,?)').run(0, failedGen1);
    db.prepare('INSERT INTO gen_metadata VALUES (?,?)').run(1, failedGen2);
    // Give step 1 completed at +5s, step 2 (USER_INPUT) started/completed at +60s/+70s, step 3 (GENERIC) at +65s/+70s, step 4 at +72s, step 10 at +200s
    db.prepare('INSERT INTO steps VALUES (?,?)').run(1, concat(bytes(1, timestamp(1735689601)), bytes(8, timestamp(1735689605))));
    db.prepare('INSERT INTO steps VALUES (?,?)').run(2, concat(bytes(1, timestamp(1735689660)), bytes(32, timestamp(1735689660)), bytes(8, timestamp(1735689670))));
    db.prepare('INSERT INTO steps VALUES (?,?)').run(3, concat(bytes(1, timestamp(1735689665)), bytes(32, timestamp(1735689665)), bytes(8, timestamp(1735689670))));
    db.prepare('INSERT INTO steps VALUES (?,?)').run(4, concat(bytes(1, timestamp(1735689672))));
    db.prepare('INSERT INTO steps VALUES (?,?)').run(10, concat(bytes(1, timestamp(1735689800))));
    db.close();

    const state = parseSessionData('sess-fix', { includeSessions: false });
    assert.equal(state.hookEventsCount, 2);
    // Turn 1's interrupted tool calls must NOT borrow turn 2's USER_INPUT or later GENERIC timing
    assert.equal(state.turns[0].toolCalls.length, 2);
    assert.equal(state.turns[0].toolCalls[0].durationMs, null);
    assert.equal(state.turns[0].toolCalls[1].durationMs, null);
    assert.equal(state.turns[0].completedAtMs, 1735689605000);
    assert.equal(state.telemetry.toolTimeMs, null);
    // 1 ERROR_MESSAGE + 2 failed requests where 1 matches ERROR_MESSAGE => deduplicated errorCount = 2 (not 3)
    assert.equal(state.errors.length, 1);
    assert.equal(state.telemetry.errorCount, 2);
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_APP_DATA_DIR;
    else process.env.ANTIGRAVITY_APP_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

