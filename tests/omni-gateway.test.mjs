import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readDatabase } from '../lib/database.mjs';
import { createWorkspaceExplorer } from '../lib/workspace-explorer.mjs';
import { createOmniGateway, resolveSafeDiffPath, resolveSafePreviewPath } from '../lib/omni-gateway.mjs';

function makeTempDir(prefix = 'agy-omni-test-') {
  return (realpathSync.native || realpathSync)(mkdtempSync(join(tmpdir(), prefix)));
}

function rawHttpRequest(urlStr, { method = 'GET', headers = {} } = {}) {
  const parsed = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request({
      method,
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: `${parsed.pathname}${parsed.search}`,
      headers
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('loopback HTTP 206 Range streaming, token/Host/Origin/Sec-Fetch-Site guards, and HTML scoped HMAC token + CSP', async () => {
  const dir = makeTempDir();
  const dataDir = join(dir, 'data');
  const mediaFile = join(dir, 'clip.mp4');
  const htmlFile = join(dir, 'preview.html');
  const payload = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
  writeFileSync(mediaFile, payload);
  writeFileSync(htmlFile, '<!doctype html><html><body><h1>Hi</h1></body></html>');

  const gateway = createOmniGateway(dataDir, { home: join(dir, 'fake-home') });
  try {
    const opened = await gateway.open({ uriOrPath: pathToFileURL(mediaFile).href });
    assert.equal(opened.ok, true);
    assert.equal(opened.kind, 'video');
    assert.equal(opened.mime, 'video/mp4');
    assert.equal(opened.size, payload.length);
    assert.equal(opened.name, 'clip.mp4');
    assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/stream\/[a-f0-9]+\?token=[a-f0-9]{64}$/);

    // Full 200 GET
    const full = await rawHttpRequest(opened.url);
    assert.equal(full.status, 200);
    assert.equal(full.headers['accept-ranges'], 'bytes');
    assert.equal(full.headers['content-type'], 'video/mp4');
    assert.equal(full.headers['content-security-policy'], "default-src 'none'; sandbox");
    assert.equal(full.body.toString('utf8'), payload.toString('utf8'));

    // 206 Range start-end
    const slice1 = await rawHttpRequest(opened.url, { headers: { Range: 'bytes=10-19' } });
    assert.equal(slice1.status, 206);
    assert.equal(slice1.headers['content-range'], `bytes 10-19/${payload.length}`);
    assert.equal(slice1.headers['content-length'], '10');
    assert.equal(slice1.body.toString('utf8'), 'ABCDEFGHIJ');

    // 206 Range open-ended & suffix
    const slice2 = await rawHttpRequest(opened.url, { headers: { Range: 'bytes=-6' } });
    assert.equal(slice2.status, 206);
    assert.equal(slice2.body.toString('utf8'), 'uvwxyz');

    // 416 out of bounds
    const badRange = await rawHttpRequest(opened.url, { headers: { Range: 'bytes=9999-10000' } });
    assert.equal(badRange.status, 416);
    assert.equal(badRange.headers['content-range'], `bytes */${payload.length}`);

    // HEAD request
    const headRes = await rawHttpRequest(opened.url, { method: 'HEAD' });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.body.length, 0);

    // POST rejected
    const postRes = await rawHttpRequest(opened.url, { method: 'POST' });
    assert.equal(postRes.status, 405);

    // Missing / wrong token rejected
    const noTokenUrl = opened.url.split('?')[0];
    assert.equal((await rawHttpRequest(noTokenUrl)).status, 403);
    assert.equal((await rawHttpRequest(`${noTokenUrl}?token=${'0'.repeat(64)}`)).status, 403);

    // DNS rebinding Host rejected
    const badHost = await rawHttpRequest(opened.url, { headers: { Host: 'evil.example.com:80' } });
    assert.equal(badHost.status, 403);

    // External Origin & Referer rejected, loopback Origin & null Origin allowed
    assert.equal((await rawHttpRequest(opened.url, { headers: { Origin: 'https://evil.com' } })).status, 403);
    assert.equal((await rawHttpRequest(opened.url, { headers: { Referer: 'https://evil.com/page' } })).status, 403);
    assert.equal((await rawHttpRequest(opened.url, { headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403);
    assert.equal((await rawHttpRequest(opened.url, {
      headers: { Origin: 'https://127.0.0.1:42311', 'Sec-Fetch-Site': 'cross-site' }
    })).status, 200);
    assert.equal((await rawHttpRequest(opened.url, { headers: { Origin: 'null' } })).status, 200);

    // HTML file gets scoped HMAC token + restrictive CSP, and its token CANNOT read clip.mp4
    const htmlOpened = await gateway.open({ uriOrPath: htmlFile });
    assert.equal(htmlOpened.kind, 'html');
    const htmlToken = new URL(htmlOpened.url).searchParams.get('token');
    const videoToken = new URL(opened.url).searchParams.get('token');
    assert.notEqual(htmlToken, videoToken);

    const htmlRes = await rawHttpRequest(htmlOpened.url);
    assert.equal(htmlRes.status, 200);
    assert.equal(
      htmlRes.headers['content-security-policy'],
      "default-src 'self' data: blob: 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'"
    );

    // Attempting to use HTML's scoped token against clip.mp4 is blocked, and vice versa
    const crossFileAttempt = await rawHttpRequest(`${noTokenUrl}?token=${htmlToken}`);
    assert.equal(crossFileAttempt.status, 403);
    const htmlNoTokenUrl = htmlOpened.url.split('?')[0];
    const reverseCrossAttempt = await rawHttpRequest(`${htmlNoTokenUrl}?token=${videoToken}`);
    assert.equal(reverseCrossAttempt.status, 403);

    // XML files are served as text/plain with sandbox CSP and an isolated per-file scoped token
    const xmlFile = join(dir, 'payload.xml');
    writeFileSync(xmlFile, '<x xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></x>');
    const xmlOpened = await gateway.open({ uriOrPath: xmlFile });
    assert.equal(xmlOpened.kind, 'code');
    assert.equal(xmlOpened.mime, 'text/plain; charset=utf-8');
    const xmlToken = new URL(xmlOpened.url).searchParams.get('token');
    assert.notEqual(xmlToken, videoToken);
    assert.notEqual(xmlToken, htmlToken);
    const xmlRes = await rawHttpRequest(xmlOpened.url);
    assert.equal(xmlRes.status, 200);
    assert.equal(xmlRes.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(xmlRes.headers['x-content-type-options'], 'nosniff');
    assert.equal(xmlRes.headers['content-security-policy'], "default-src 'none'; sandbox");
    assert.equal((await rawHttpRequest(`${noTokenUrl}?token=${xmlToken}`)).status, 403);

    // Verify classification of all remaining kinds (audio, pdf, image, svg, table, font, code, binary)
    const sampleKinds = [
      ['sound.mp3', 'audio', 'audio/mpeg'],
      ['doc.pdf', 'pdf', 'application/pdf'],
      ['pic.webp', 'image', 'image/webp'],
      ['diagram.svg', 'svg', 'image/svg+xml'],
      ['data.csv', 'table', 'text/csv; charset=utf-8'],
      ['type.woff2', 'font', 'font/woff2'],
      ['index.ts', 'code', 'text/plain; charset=utf-8'],
      ['feed.xml', 'code', 'text/plain; charset=utf-8'],
      ['blob.bin', 'binary', 'application/octet-stream']
    ];
    for (const [fname, expectedKind, expectedMime] of sampleKinds) {
      const fpath = join(dir, fname);
      writeFileSync(fpath, 'sample');
      const res = await gateway.open({ uriOrPath: fpath });
      assert.equal(res.kind, expectedKind);
      assert.equal(res.mime, expectedMime);
      if (expectedKind === 'pdf') {
        const pdfRes = await rawHttpRequest(res.url);
        assert.equal(pdfRes.status, 200);
        assert.ok(pdfRes.headers['content-security-policy']?.includes("object-src 'self'"));
        assert.equal(pdfRes.headers['content-security-policy']?.includes('sandbox'), false, 'PDF stream CSP must not set sandbox directive that blocks Chromium PDFium');
      }
    }

    // TOCTOU symlink swap after open() is rejected at stream time
    const swapTarget = join(dir, 'swap.txt');
    const secretFile = join(dir, 'secret.pem');
    writeFileSync(swapTarget, 'safe');
    writeFileSync(secretFile, 'PRIVATE KEY');
    const swapOpened = await gateway.open({ uriOrPath: swapTarget });
    rmSync(swapTarget);
    symlinkSync(secretFile, swapTarget);
    const swapRes = await rawHttpRequest(swapOpened.url);
    assert.equal(swapRes.status, 404);
  } finally {
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('path security blocks UNC, Windows device paths, traversal, sensitive credential paths, and symlinks to secrets', async () => {
  const dir = makeTempDir();
  const fakeHome = join(dir, 'home');
  const sshDir = join(fakeHome, '.ssh');
  const awsDir = join(fakeHome, '.aws');
  const pluginDataDir = join(fakeHome, '.gemini', 'antigravity', 'plugin_data', 'agy-powertools');
  const agyMaxDataDir = join(fakeHome, '.gemini', 'antigravity', 'plugin_data', 'agy-max');
  const agyMaxRuntimeDir = join(agyMaxDataDir, 'runtime');
  const dockerDir = join(fakeHome, '.docker');
  const pluginCfgDir = join(fakeHome, '.gemini', 'config', 'plugins', 'demo');
  mkdirSync(sshDir, { recursive: true });
  mkdirSync(awsDir, { recursive: true });
  mkdirSync(pluginDataDir, { recursive: true });
  mkdirSync(agyMaxRuntimeDir, { recursive: true });
  mkdirSync(dockerDir, { recursive: true });
  mkdirSync(pluginCfgDir, { recursive: true });

  const sshKey = join(sshDir, 'id_ed25519');
  const awsCreds = join(awsDir, 'credentials');
  const accountsFile = join(pluginDataDir, 'accounts.json');
  const legacySettingsFile = join(pluginDataDir, 'settings.json');
  const agyMaxRuntimeToken = join(agyMaxRuntimeDir, 'host.json');
  const agyMaxSettingsFile = join(agyMaxDataDir, 'settings.json');
  const netrcFile = join(fakeHome, '.netrc');
  const npmrcFile = join(fakeHome, '.npmrc');
  const pypircFile = join(fakeHome, '.pypirc');
  const dockerConfigFile = join(dockerDir, 'config.json');
  const thoughtProfiles = join(pluginCfgDir, 'thought-profiles.json');
  const dotEnv = join(dir, '.env');
  const pemFile = join(dir, 'server.pem');
  const keyFile = join(dir, 'tls.key');
  const credFile = join(dir, 'gcp-credential-prod.json');
  const safeFile = join(dir, 'notes.txt');

  for (const f of [
    sshKey, awsCreds, accountsFile, legacySettingsFile, agyMaxRuntimeToken, agyMaxSettingsFile,
    netrcFile, npmrcFile, pypircFile, dockerConfigFile, thoughtProfiles, dotEnv, pemFile, keyFile, credFile, safeFile
  ]) {
    writeFileSync(f, 'content');
  }

  // Symlink disguised as harmless .txt pointing to ~/.ssh/id_ed25519
  const sneakyLink = join(dir, 'harmless.txt');
  symlinkSync(sshKey, sneakyLink);

  const opts = { home: fakeHome };
  try {
    assert.equal(resolveSafePreviewPath(safeFile, opts).name, 'notes.txt');

    const rejected = [
      '\\\\server\\share\\video.mp4',
      '//server/share/video.mp4',
      'file://fileserver/share/video.mp4',
      '\\\\.\\PhysicalDrive0',
      '\\\\?\\C:\\Windows\\system32\\cmd.exe',
      '../outside.txt',
      `${dir}/../outside.txt`,
      `file://${dir}/%2e%2e/outside.txt`,
      sshKey,
      awsCreds,
      accountsFile,
      legacySettingsFile,
      agyMaxRuntimeToken,
      agyMaxSettingsFile,
      netrcFile,
      npmrcFile,
      pypircFile,
      dockerConfigFile,
      thoughtProfiles,
      dotEnv,
      pemFile,
      keyFile,
      credFile,
      sneakyLink
    ];

    for (const bad of rejected) {
      assert.throws(() => resolveSafePreviewPath(bad, opts), `Expected rejection for: ${bad}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tableSlice streams CSV (RFC 4180 quotes/BOM/CJK), TSV, JSONL, filters, paginates, and truncates safely', async () => {
  const dir = makeTempDir();
  const gateway = createOmniGateway(join(dir, 'data'), {
    home: join(dir, 'home'),
    maxTableScanBytes: 1024
  });

  try {
    const csvPath = join(dir, 'metrics.csv');
    writeFileSync(csvPath, [
      '\uFEFFname,note,score',
      'Alice,"hello, ""world""",95',
      'Bob,"line1\nline2",88',
      '陈明,"中文测试, 逗号",99',
      'David,plain,72'
    ].join('\r\n'));

    const csvAll = await gateway.tableSlice({ uriOrPath: csvPath, offset: 0, limit: 10 });
    assert.equal(csvAll.ok, true);
    assert.equal(csvAll.format, 'csv');
    assert.deepEqual(csvAll.headers, ['name', 'note', 'score']);
    assert.equal(csvAll.totalMatched, 4);
    assert.equal(csvAll.truncated, false);
    assert.deepEqual(csvAll.rows[0], ['Alice', 'hello, "world"', '95']);
    assert.deepEqual(csvAll.rows[1], ['Bob', 'line1\nline2', '88']);
    assert.deepEqual(csvAll.rows[2], ['陈明', '中文测试, 逗号', '99']);

    const csvFiltered = await gateway.tableSlice({ uriOrPath: csvPath, offset: 0, limit: 1, query: '中文' });
    assert.equal(csvFiltered.totalMatched, 1);
    assert.deepEqual(csvFiltered.rows, [['陈明', '中文测试, 逗号', '99']]);

    const tsvPath = join(dir, 'items.tsv');
    writeFileSync(tsvPath, 'id\ttitle\n1\tAlpha\n2\tBeta\n3\tGamma\n');
    const tsvPage = await gateway.tableSlice({ uriOrPath: tsvPath, offset: 1, limit: 1 });
    assert.equal(tsvPage.format, 'tsv');
    assert.equal(tsvPage.totalMatched, 3);
    assert.deepEqual(tsvPage.rows, [['2', 'Beta']]);

    const jsonlPath = join(dir, 'events.jsonl');
    writeFileSync(jsonlPath, [
      JSON.stringify({ id: 1, kind: 'start', meta: { ok: true } }),
      JSON.stringify({ id: 2, kind: 'finish', extra: 'bonus' }),
      JSON.stringify({ id: 3, kind: 'start', extra: 'later' })
    ].join('\n'));
    const jsonlRes = await gateway.tableSlice({ uriOrPath: jsonlPath, offset: 0, limit: 10, query: 'start' });
    assert.equal(jsonlRes.format, 'jsonl');
    assert.deepEqual(jsonlRes.headers, ['id', 'kind', 'meta', 'extra']);
    assert.equal(jsonlRes.totalMatched, 2);
    assert.deepEqual(jsonlRes.rows[0], ['1', 'start', '{"ok":true}', '']);
    assert.deepEqual(jsonlRes.rows[1], ['3', 'start', '', 'later']);

    // Exceed maxTableScanBytes (1024 in this test instance) -> truncated: true
    const bigCsv = join(dir, 'big.csv');
    const lines = ['col1,col2'];
    for (let i = 0; i < 200; i++) lines.push(`row-${i},${'x'.repeat(20)}`);
    writeFileSync(bigCsv, lines.join('\n'));
    const truncRes = await gateway.tableSlice({ uriOrPath: bigCsv, offset: 0, limit: 500 });
    assert.equal(truncRes.truncated, true);
    assert.ok(truncRes.totalMatched < 200);
  } finally {
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inlineDiff enforces --no-optional-locks and --literal-pathspecs, handles tracked/untracked/binary/truncation/traversal', async () => {
  const dir = makeTempDir();
  const repoDir = join(dir, 'repo');
  mkdirSync(repoDir, { recursive: true });

  const observedArgs = [];
  const observedEnvs = [];
  const trackingExecGit = (cmd, args, opts, cb) => {
    observedArgs.push(args);
    observedEnvs.push(opts?.env);
    return execFile(cmd, args, opts, cb);
  };

  const gateway = createOmniGateway(join(dir, 'data'), {
    home: join(dir, 'home'),
    execGit: trackingExecGit
  });

  try {
    const git = (...args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
    const init = git('init', '-b', 'main');
    if (init.status !== 0) git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');

    writeFileSync(join(repoDir, 'app.js'), 'const a = 1;\nconst b = 2;\n');
    writeFileSync(join(repoDir, 'big.txt'), Array.from({ length: 400 }, (_, i) => `old-${i}`).join('\n') + '\n');
    writeFileSync(join(repoDir, 'img.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    git('add', 'app.js', 'big.txt', 'img.bin');
    git('commit', '-m', 'init');

    // Modify tracked file
    writeFileSync(join(repoDir, 'app.js'), 'const a = 1;\nconst b = 42;\nconst c = 3;\n');
    // Modify large tracked file (>300 diff lines)
    writeFileSync(join(repoDir, 'big.txt'), Array.from({ length: 400 }, (_, i) => `new-${i}`).join('\n') + '\n');
    // Modify tracked binary file
    writeFileSync(join(repoDir, 'img.bin'), Buffer.from([0x00, 0xff, 0xfe, 0x03]));
    // Untracked text file (>120 lines)
    writeFileSync(join(repoDir, 'untracked.txt'), Array.from({ length: 150 }, (_, i) => `line-${i + 1}`).join('\n') + '\n');
    // Untracked binary file
    writeFileSync(join(repoDir, 'bin.dat'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));

    const workspaceUri = pathToFileURL(repoDir).href;

    const trackedDiff = await gateway.inlineDiff({ workspaceUri, path: 'app.js' });
    assert.equal(trackedDiff.ok, true);
    assert.equal(trackedDiff.binary, false);
    assert.equal(trackedDiff.untracked, false);
    assert.equal(trackedDiff.truncated, false);
    assert.ok(trackedDiff.lines.some(l => l.kind === 'hunk'));
    assert.ok(trackedDiff.lines.some(l => l.kind === 'del' && l.text === 'const b = 2;'));
    assert.ok(trackedDiff.lines.some(l => l.kind === 'add' && l.text === 'const b = 42;'));
    assert.ok(trackedDiff.lines.some(l => l.kind === 'ctx' && l.text === 'const a = 1;'));

    const trackedBinDiff = await gateway.inlineDiff({ workspaceUri, path: 'img.bin' });
    assert.equal(trackedBinDiff.ok, true);
    assert.equal(trackedBinDiff.binary, true);
    assert.equal(trackedBinDiff.untracked, false);
    assert.deepEqual(trackedBinDiff.lines, []);

    const bigDiff = await gateway.inlineDiff({ workspaceUri, path: join(repoDir, 'big.txt') });
    assert.equal(bigDiff.truncated, true);
    assert.equal(bigDiff.lines.length, 300);

    const untrackedDiff = await gateway.inlineDiff({ workspaceUri, path: 'untracked.txt' });
    assert.equal(untrackedDiff.untracked, true);
    assert.equal(untrackedDiff.binary, false);
    assert.equal(untrackedDiff.truncated, true);
    assert.equal(untrackedDiff.lines.filter(l => l.kind === 'add').length, 120);

    const binDiff = await gateway.inlineDiff({ workspaceUri, path: 'bin.dat' });
    assert.equal(binDiff.untracked, true);
    assert.equal(binDiff.binary, true);
    assert.deepEqual(binDiff.lines, []);

    // Verify safety flags on every git invocation
    assert.ok(observedArgs.length > 0);
    assert.ok(observedArgs.every(args =>
      args[0] === '--no-optional-locks' &&
      args[1] === '--literal-pathspecs' &&
      args.includes('core.fsmonitor=false') &&
      args.includes('core.untrackedCache=false') &&
      args.includes('core.sshCommand=false') &&
      args.includes('diff.external=') &&
      args.includes('core.pager=cat')
    ));
    assert.ok(observedEnvs.every(env => env?.GIT_TERMINAL_PROMPT === '0'));
    assert.ok(observedArgs.filter(a => a.includes('diff')).every(a =>
      a.includes('--no-ext-diff') && a.includes('--no-textconv') && a.includes('--ignore-submodules=all')
    ));

    // Malicious core.fsmonitor must never execute
    const fsmonMarker = join(dir, 'omni-fsmonitor-pwned.txt');
    git('config', 'core.fsmonitor', `node -e "require('fs').writeFileSync(${JSON.stringify(fsmonMarker)}, 'pwned')"`);
    const safeAfterFsmon = await gateway.inlineDiff({ workspaceUri, path: 'app.js' });
    assert.equal(safeAfterFsmon.ok, true);
    assert.equal(existsSync(fsmonMarker), false);

    // Reject path traversal outside repo
    await assert.rejects(() => gateway.inlineDiff({ workspaceUri, path: '../outside.txt' }), /超出/);
    await assert.rejects(() => gateway.inlineDiff({ workspaceUri, path: '/etc/passwd' }), /超出/);
    await assert.rejects(() => gateway.inlineDiff({ workspaceUri, path: '.git/config' }), /超出/);
  } finally {
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveSafeDiffPath handles percent-encoded URIs, deleted nested files, and rejects symlinks/.git/sensitive paths', () => {
  const dir = makeTempDir('agy-safe-diff-path-');
  const root = join(dir, 'repo');
  const sub = join(root, 'my app');
  mkdirSync(sub, { recursive: true });
  const cjkFile = join(sub, '中文 文件.txt');
  writeFileSync(cjkFile, 'ok\n');
  const fakeHome = join(dir, 'home');
  mkdirSync(fakeHome, { recursive: true });

  try {
    const rootReal = resolveSafePreviewPath(cjkFile, { home: fakeHome }).realPath.replace(/[\\/]my app[\\/][^\\/]+$/, '');

    // Percent-encoded file:// URI with #hash and ?query
    const cjkUri = `${pathToFileURL(cjkFile).href}?v=1#L3`;
    const existing = resolveSafeDiffPath(rootReal, cjkUri, { home: fakeHome });
    assert.equal(existing.exists, true);
    assert.equal(existing.relPath, 'my app/中文 文件.txt');

    // Deleted file in existing and non-existent nested subdirectories
    const deletedNested = resolveSafeDiffPath(rootReal, 'deleted-dir/nested/old.js', { home: fakeHome });
    assert.equal(deletedNested.exists, false);
    assert.equal(deletedNested.relPath, 'deleted-dir/nested/old.js');

    // Reject .git and sensitive deleted files
    assert.throws(() => resolveSafeDiffPath(rootReal, '.git/HEAD', { home: fakeHome }));
    assert.throws(() => resolveSafeDiffPath(rootReal, '.env', { home: fakeHome }));
    assert.throws(() => resolveSafeDiffPath(rootReal, 'sub/.env.local', { home: fakeHome }));

    if (process.platform !== 'win32') {
      symlinkSync(dir, join(root, 'escape-dir'));
      assert.throws(() => resolveSafeDiffPath(rootReal, 'escape-dir/missing.txt', { home: fakeHome }));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archiveScan, archiveRun, and archiveRestore move stale subagent conversations and restore losslessly', async () => {
  const dir = makeTempDir();
  const dataDir = join(dir, 'data');
  const brainDir = join(dir, 'brain');
  const now = Date.now();
  const oldDate = new Date(now - 12 * 24 * 60 * 60 * 1000);
  const recentDate = new Date(now - 2 * 24 * 60 * 60 * 1000);

  const makeConv = (id, transcriptLine, mtimeDate) => {
    const convDir = join(brainDir, id);
    const logsDir = join(convDir, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const transcriptFile = join(logsDir, 'transcript.jsonl');
    const artifactFile = join(convDir, 'notes.md');
    writeFileSync(transcriptFile, JSON.stringify(transcriptLine) + '\n');
    writeFileSync(artifactFile, `artifact for ${id}`);
    utimesSync(transcriptFile, mtimeDate, mtimeDate);
    utimesSync(artifactFile, mtimeDate, mtimeDate);
    utimesSync(convDir, mtimeDate, mtimeDate);
  };

  // Old subagent (identified via transcript metadata) -> eligible
  makeConv('sub-old-1', { step_index: 0, source: 'subagent', parent_conversation_id: 'main-1' }, oldDate);
  // Old explicit subagent (passed via subagentIds) -> eligible
  makeConv('sub-explicit-2', { step_index: 0, source: 'USER_EXPLICIT' }, oldDate);
  // Recent subagent (< 7 days) -> NOT eligible
  makeConv('sub-recent-3', { step_index: 0, is_subagent: true }, recentDate);
  // Old main conversation (not subagent) -> NOT eligible
  makeConv('main-old-4', { step_index: 0, source: 'USER_EXPLICIT' }, oldDate);

  const gateway = createOmniGateway(dataDir, { brainDir, home: join(dir, 'home') });
  try {
    const scan = gateway.archiveScan({ maxAgeDays: 7, subagentIds: ['sub-explicit-2'], now });
    assert.equal(scan.ok, true);
    assert.equal(scan.scannedCount, 4);
    assert.equal(scan.eligibleCount, 2);
    assert.deepEqual(scan.candidates.map(c => c.id).sort(), ['sub-explicit-2', 'sub-old-1']);
    assert.ok(scan.eligibleBytes > 0);

    const runRes = gateway.archiveRun({ maxAgeDays: 7, subagentIds: ['sub-explicit-2'], now });
    assert.equal(runRes.ok, true);
    assert.equal(runRes.archivedCount, 2);
    assert.deepEqual(runRes.archivedIds.sort(), ['sub-explicit-2', 'sub-old-1']);
    assert.equal(existsSync(join(brainDir, 'sub-old-1')), false);
    assert.equal(existsSync(join(brainDir, 'sub-explicit-2')), false);
    assert.equal(existsSync(join(brainDir, 'sub-recent-3')), true);
    assert.equal(existsSync(join(brainDir, 'main-old-4')), true);
    assert.equal(existsSync(join(dataDir, 'archived-conversations', 'manifest.json')), true);

    // Restore losslessly
    const restoreRes = gateway.archiveRestore();
    assert.equal(restoreRes.ok, true);
    assert.equal(restoreRes.restoredCount, 2);
    assert.deepEqual(restoreRes.restoredIds.sort(), ['sub-explicit-2', 'sub-old-1']);
    assert.equal(restoreRes.remainingArchivedCount, 0);
    assert.equal(readFileSync(join(brainDir, 'sub-old-1', 'notes.md'), 'utf8'), 'artifact for sub-old-1');
    assert.equal(readFileSync(join(brainDir, 'sub-explicit-2', 'notes.md'), 'utf8'), 'artifact for sub-explicit-2');
    // Non-clobber check: re-archive, create a conflicting folder at destination, verify restore skips without clobbering
    gateway.archiveRun({ maxAgeDays: 7, subagentIds: ['sub-explicit-2'], now });
    mkdirSync(join(brainDir, 'sub-old-1'), { recursive: true });
    writeFileSync(join(brainDir, 'sub-old-1', 'new.md'), 'do-not-overwrite');
    const safeRestore = gateway.archiveRestore();
    assert.deepEqual(safeRestore.restoredIds, ['sub-explicit-2']);
    assert.equal(safeRestore.skipped.length, 1);
    assert.equal(safeRestore.skipped[0].id, 'sub-old-1');
    assert.equal(safeRestore.skipped[0].reason, 'destination-exists');
    assert.equal(safeRestore.remainingArchivedCount, 1);
    assert.equal(readFileSync(join(brainDir, 'sub-old-1', 'new.md'), 'utf8'), 'do-not-overwrite');
  } finally {
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chatFoldersGet and chatFoldersSave persist folders and prune dangling assignments', async () => {
  const dir = makeTempDir();
  const gateway = createOmniGateway(join(dir, 'data'), { home: join(dir, 'home') });
  try {
    assert.deepEqual(gateway.chatFoldersGet(), { ok: true, folders: [], assignments: {} });

    const saved = gateway.chatFoldersSave({
      folders: [
        { id: 'f-daily', name: '日常问答', color: '#669DF6' },
        { id: 'f-notes', name: '灵感整理' }
      ],
      assignments: {
        'conv-1': 'f-daily',
        'conv-2': 'f-notes',
        'conv-orphan': 'f-deleted'
      }
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.folders.length, 2);
    assert.deepEqual(saved.assignments, { 'conv-1': 'f-daily', 'conv-2': 'f-notes' });

    const loaded = gateway.chatFoldersGet();
    assert.deepEqual(loaded, saved);
  } finally {
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('omni-gateway source and test contain no middle-dot character (U+00B7)', () => {
  const src = readFileSync(new URL('../lib/omni-gateway.mjs', import.meta.url), 'utf8');
  const tst = readFileSync(new URL('./omni-gateway.test.mjs', import.meta.url), 'utf8');
  assert.equal(src.includes('\u00b7'), false);
  assert.equal(tst.includes('\u00b7'), false);
});

test('workspace explorer requires approval, supports host candidates and Windows path searches', async () => {
  const dir = makeTempDir();
  try {
    const project = join(dir, '\u9879\u76ee');
    const outside = join(dir, 'outside');
    const host = join(dir, 'host-workspace');
    const notes = join(project, '..notes');
    mkdirSync(notes, { recursive: true });
    mkdirSync(outside);
    mkdirSync(host);
    const textPath = join(notes, '\u8bf4\u660e.md');
    writeFileSync(textPath, 'notes');
    const rootUri = pathToFileURL(project).href;
    const fileUri = pathToFileURL(textPath).href;
    const options = {
      appDir: null, dataDir: join(dir, 'data'), homeDir: dir, platform: 'win32',
      runCommand(cmd, args) {
        assert.equal(cmd, 'powershell.exe');
        assert.match(args.at(-1), /^\[Console\]::OutputEncoding = \[Text\.UTF8Encoding\]::new\(\$false\);/);
        return { ok: true, stdout: project + '\r\n' };
      }
    };
    const explorer = createWorkspaceExplorer(options);
    for (const act of [
      () => explorer.listDir({ rootUri }),
      () => explorer.searchFiles({ rootUri, query: 'notes' }),
      () => explorer.readFilePreview({ rootUri, fileUri }),
      () => explorer.writeTextFile({ rootUri, fileUri, content: 'changed', overwrite: true })
    ]) assert.throws(act, /\u672a\u6388\u6743/);
    const [hostWorkspace] = explorer.recentWorkspaces({ clientWorkspaces: [host] });
    assert.equal(explorer.listDir({ rootUri: hostWorkspace.uri }).entries.length, 0);
    assert.throws(() => explorer.listDir({ rootUri: outside }), /\u672a\u6388\u6743/);
    assert.equal((await explorer.pickFolder()).uri, rootUri);
    assert.equal(explorer.listDir({ rootUri, relPath: '..notes' }).entries.length, 1);
    assert.equal(explorer.searchFiles({ rootUri, query: '..notes\\\u8bf4\u660e' }).entries[0].uri, fileUri);
    assert.equal(createWorkspaceExplorer(options).readFilePreview({ rootUri, fileUri }).content, 'notes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inlineDiff accepts files underneath a directory named ..notes', async () => {
  const dir = makeTempDir();
  try {
    const notes = join(dir, '..notes');
    mkdirSync(notes);
    writeFileSync(join(notes, 'file.txt'), 'note content\n');
    const gateway = createOmniGateway(dir, {
      execGit(_cmd, args, _opts, done) {
        if (args.includes('rev-parse')) done(null, dir + '\n');
        else done(null, '..notes/file.txt\n');
      }
    });
    const diff = await gateway.inlineDiff({ workspaceUri: pathToFileURL(dir).href, path: '..notes/file.txt' });
    assert.equal(diff.untracked, true);
    await assert.rejects(() => gateway.inlineDiff({ workspaceUri: dir, path: '../file.txt' }), /Git/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readDatabase reports a locked SQLite file and can read it after release', () => {
  const dir = makeTempDir();
  let writer;
  try {
    const conversations = join(dir, 'conversations');
    mkdirSync(conversations);
    writer = new DatabaseSync(join(conversations, 'locked.db'));
    writer.exec('CREATE TABLE gen_metadata (idx, data); CREATE TABLE steps (idx, metadata); BEGIN EXCLUSIVE;');
    const reasons = [];
    const onUnavailable = reason => reasons.push(reason);
    assert.equal(readDatabase(dir, 'locked', { onUnavailable }), null);
    assert.deepEqual(reasons, ['locked']);
    writer.exec('ROLLBACK');
    assert.deepEqual(readDatabase(dir, 'locked', { onUnavailable }).generations, []);
    assert.equal(readDatabase(dir, 'missing', { onUnavailable }), null);
    assert.deepEqual(reasons, ['locked', 'missing']);
  } finally {
    writer?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
