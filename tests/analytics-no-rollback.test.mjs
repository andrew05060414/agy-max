import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { usageDashboard } from '../lib/analytics.mjs';

const varint = value => { const a = []; let n = BigInt(value); do { let b = Number(n & 127n); n >>= 7n; if (n) b |= 128; a.push(b); } while (n); return Buffer.from(a); };
const integer = (n, value) => Buffer.concat([varint(n * 8), varint(value)]);
const bytes = (n, value) => { const b = Buffer.from(value); return Buffer.concat([varint(n * 8 + 2), varint(b.length), b]); };
const makeGen = (reqId, modelName, outTokens) => Buffer.concat([
  bytes(1, Buffer.concat([
    bytes(4, Buffer.concat([integer(2, 100), integer(3, outTokens)])),
    bytes(19, modelName),
    bytes(20, Buffer.concat([bytes(1, 'request_id'), bytes(2, reqId)]))
  ])),
  integer(2, 1)
]);

function writeConvDb(convDir, id, reqId, tsSec) {
  const dbPath = join(convDir, `${id}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS gen_metadata(idx INTEGER PRIMARY KEY,data BLOB); CREATE TABLE IF NOT EXISTS steps(idx INTEGER PRIMARY KEY,metadata BLOB);');
  db.prepare('INSERT OR REPLACE INTO gen_metadata VALUES (?,?)').run(0, makeGen(reqId, 'Gemini 4 Neon', 120));
  db.prepare('INSERT OR REPLACE INTO steps VALUES (?,?)').run(1, bytes(1, integer(1, tsSec)));
  db.close();
  return dbPath;
}

test('usageDashboard keeps the last good events when a .db is unreadable or the folder read fails transiently', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-no-rollback-'));
  const convDir = join(root, 'conversations');
  mkdirSync(convDir, { recursive: true });
  try {
    const paths = [0, 1, 2].map(i => writeConvDb(convDir, `conv-${i}`, `req-${i}`, 1735689600 + i * 10));
    assert.equal(usageDashboard(root, { force: true }).totalRequests, 3);

    // A half-written / locked database must not make its requests vanish from this scan
    writeFileSync(paths[1], 'not a sqlite database');
    const future = new Date(Date.now() + 5000);
    utimesSync(paths[1], future, future);
    const corrupt = usageDashboard(root, { force: true });
    assert.equal(corrupt.totalRequests, 3);
    assert.ok(corrupt.requests.some(r => r.id === 'req-1'));

    // Deleting a .db still prunes its events (unchanged contract)
    unlinkSync(paths[2]);
    assert.equal(usageDashboard(root, { force: true }).totalRequests, 2);

    // Transient folder failure (ENOTDIR here) reuses the last good scan instead of zeroing
    const parked = join(root, 'conversations.parked');
    renameSync(convDir, parked);
    writeFileSync(convDir, '');
    assert.equal(usageDashboard(root, { force: true }).totalRequests, 2);

    // A genuinely missing folder (ENOENT) reports the truth
    unlinkSync(convDir);
    assert.equal(usageDashboard(root, { force: true }).totalRequests, 0);
    renameSync(parked, convDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
