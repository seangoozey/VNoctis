import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import savesRoutes, { validateSnapshot } from '../src/routes/saves.js';

const snapshot = (data = 'device A') => ({ version: 1, files: [
  { path: 'test/1-1-LT1.save', mtime: 1000, data: Buffer.from(data).toString('base64') },
  { path: 'test/persistent', mtime: 1001, data: 'AA==' },
  { path: 'tokens/security_keys.txt', mtime: 1002, data: 'AQ==' },
] });

test('snapshot rejects traversal, ambiguous trees, malformed bytes and invalid timestamps', () => {
  assert.equal(validateSnapshot(snapshot()), true);
  for (const path of ['../save', '/save', 'x/../save', 'x\\save', 'x//save', 'x\0save']) {
    const copy = snapshot(); copy.files[0].path = path;
    assert.equal(validateSnapshot(copy), false, path);
  }
  const duplicate = snapshot(); duplicate.files.push(duplicate.files[0]);
  assert.equal(validateSnapshot(duplicate), false);
  const ancestor = snapshot(); ancestor.files.push({ path: 'test', mtime: 0, data: '' });
  assert.equal(validateSnapshot(ancestor), false);
  const bad = snapshot(); bad.files[0].data = '*invalid*';
  assert.equal(validateSnapshot(bad), false);
  bad.files[0] = { path: 'test/save', data: '', mtime: -1 };
  assert.equal(validateSnapshot(bad), false);
});

test('large legitimate base64 files validate without regex stack exhaustion', () => {
  const copy = snapshot(); copy.files[0].data = 'A'.repeat(40 * 1024 * 1024);
  assert.equal(validateSnapshot(copy), true);
});

test('SQLite migration and authenticated per-user/game revision API', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'vnm-save-test-'));
  const prisma = new PrismaClient({ datasourceUrl: `file:${join(directory, 'test.db').replaceAll('\\', '/')}` });
  const app = Fastify(); app.decorate('prisma', prisma);
  try {
    // Apply the committed migrations, not db push; the existing missing R2 columns
    // do not block this feature's id-only game access check.
    const migrations = new URL('../prisma/migrations/', import.meta.url);
    for (const name of readdirSync(migrations).filter(n => n !== 'migration_lock.toml').sort()) {
      if (name === '20261007000000_save_sync_retention') {
        await prisma.$executeRawUnsafe('INSERT INTO User (id,username,passwordHash,updatedAt) VALUES (?,?,?,?)', 'seed', 'seed', 'unused', new Date());
        await prisma.$executeRawUnsafe('INSERT INTO Game (id,directoryPath,directoryName,extractedTitle,updatedAt) VALUES (?,?,?,?,?)', 'seed', '/games/seed', 'seed', 'Original Title', new Date());
        await prisma.$executeRawUnsafe('INSERT INTO SaveSyncState (userId,gameId,revision,payload,checksum,updatedAt) VALUES (?,?,?,?,?,?)', 'seed', 'seed', 7, JSON.stringify(snapshot('existing progress')), 'existing-checksum', new Date());
      }
      const sql = readFileSync(new URL(`${name}/migration.sql`, migrations), 'utf8');
      for (const statement of sql.split(';').filter(s => s.trim())) await prisma.$executeRawUnsafe(statement);
    }
    const migrated = await prisma.saveSyncState.findUnique({ where: { userId_gameId: { userId: 'seed', gameId: 'seed' } } });
    assert.equal(migrated.revision, 7); assert.equal(migrated.gameTitle, 'Original Title');
    assert.equal(migrated.checksum, 'existing-checksum');
    assert.deepEqual(JSON.parse(migrated.payload), snapshot('existing progress'));
    await prisma.user.delete({ where: { id: 'seed' } });
    await prisma.$executeRawUnsafe('DELETE FROM Game WHERE id = ?', 'seed');
    await prisma.user.createMany({ data: ['A', 'B'].map(id => ({ id, username: id, passwordHash: 'unused' })) });
    await prisma.user.update({ where: { id: 'A' }, data: { role: 'admin' } });
    for (const id of ['X', 'Y']) await prisma.$executeRawUnsafe(
      'INSERT INTO Game (id,directoryPath,directoryName,extractedTitle,updatedAt) VALUES (?,?,?,?,?)', id, `/games/${id}`, id, id, new Date());
    app.addHook('onRequest', async (request, reply) => {
      // Route integration fixture: production assigns this from a verified JWT.
      const userId = request.headers.authorization;
      if (!['A', 'B'].includes(userId)) return reply.code(401).send({});
      request.user = { userId };
    });
    await app.register(savesRoutes, { prefix: '/api/v1' });
    const get = (user, game = 'X') => app.inject({ method: 'GET', url: `/api/v1/games/${game}/saves`, headers: { authorization: user } });
    const put = (user, revision, copy = snapshot(), game = 'X') => app.inject({ method: 'PUT', url: `/api/v1/games/${game}/saves`, headers: { authorization: user }, payload: { revision, snapshot: copy, userId: 'B' } });
    await t.test('first browser upload is visible to another session of the same user', async () => {
      assert.equal((await put('A', 0)).statusCode, 200);
      const response = await get('A'); assert.equal(response.json().revision, 1);
      assert.deepEqual(response.json().snapshot, snapshot());
      assert.equal(response.headers['cache-control'], 'no-store');
    });
    await t.test('request body cannot select another user and games cannot collide', async () => {
      assert.equal((await get('B')).json().snapshot, null);
      assert.equal((await get('A', 'Y')).json().snapshot, null);
      assert.equal((await get('missing')).statusCode, 401);
      assert.equal((await get('A', 'absent')).statusCode, 404);
      assert.equal((await get('A', '..%2Fx')).statusCode, 400);
    });
    await t.test('concurrent progress preserves an alternate without overwriting the first writer', async () => {
      const results = await Promise.all([put('A', 1, snapshot('B')), put('A', 1, snapshot('C'))]);
      assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 200]);
      assert.deepEqual(results.map(r => r.json().disposition).sort(), ['alternate', 'current']);
      assert.equal((await get('A')).json().revision, 2);
      assert.equal((await put('A', 0)).json().revision, 1);
    });
    await t.test('invalid snapshot and oversized body leave server state intact', async () => {
      const copy = snapshot(); copy.files[0].path = '../attack';
      assert.equal((await put('A', 2, copy)).statusCode, 400);
      const huge = snapshot(); huge.files[0].data = 'A'.repeat(46 * 1024 * 1024);
      assert.equal((await put('A', 2, huge)).statusCode, 413);
      assert.equal((await get('A')).json().revision, 2);
    });
    await t.test('upload IDs acknowledge retries and reject reused IDs or competing progress', async () => {
      const send = (revision, uploadId, copy = snapshot()) => app.inject({ method: 'PUT', url: '/api/v1/games/Y/saves',
        headers: { authorization: 'B' }, payload: { revision, uploadId, snapshot: copy } });
      assert.equal((await send(0, 'request-1')).json().revision, 1);
      const retries = await Promise.all([send(0, 'request-1'), send(0, 'request-1')]);
      assert.ok(retries.every(response => response.statusCode === 200 && response.json().revision === 1));
      assert.equal((await send(1, 'request-1', snapshot('different'))).statusCode, 409);
      assert.equal((await get('B', 'Y')).json().uploadId, 'request-1');
      const newer = await send(1, 'request-2', snapshot('newer'));
      assert.equal(newer.statusCode, 200, newer.body);
      assert.equal(newer.json().revision, 2);
      assert.equal((await send(0, 'request-1')).json().revision, 1, 'older retry acknowledges its original receipt');
      assert.equal((await get('B', 'Y')).json().revision, 2, 'acknowledgement does not overwrite newer progress');
    });
    await t.test('missing games retain saves; admin cleanup protects active and returned games', async () => {
      const admin = (method, path = '', payload, user = 'A') => app.inject({ method,
        url: `/api/v1/admin/orphaned-saves${path}`, headers: { authorization: user }, payload });
      await prisma.$executeRawUnsafe('UPDATE Game SET webBuildPath = ? WHERE id = ?', '/web-builds/new-version', 'X');
      assert.equal((await get('A')).json().revision, 2);
      assert.equal((await admin('DELETE', '/A/X', { revision: 2 })).statusCode, 409);
      await prisma.$executeRawUnsafe('DELETE FROM Game WHERE id = ?', 'X');
      assert.equal((await get('A')).statusCode, 404);
      assert.equal(await prisma.saveSyncState.count(), 2);
      for (const [method, path, payload] of [['GET', ''], ['GET', '/A/X'], ['DELETE', '/A/X', { revision: 2 }]]) {
        assert.equal((await admin(method, path, payload, 'B')).statusCode, 403);
      }
      const list = (await admin('GET')).json();
      assert.equal(list.items.length, 1); assert.equal(list.items[0].gameTitle, 'X');
      assert.equal(list.items[0].username, 'A'); assert.equal('payload' in list.items[0], false);
      const stored = await prisma.saveSyncState.findUnique({ where: { userId_gameId: { userId: 'A', gameId: 'X' } } });
      assert.deepEqual((await admin('GET', '/A/X')).json().snapshot, JSON.parse(stored.payload));
      assert.equal((await admin('DELETE', '/A/X', { revision: 1 })).statusCode, 409);
      await prisma.$executeRawUnsafe('INSERT INTO Game (id,directoryPath,directoryName,extractedTitle,updatedAt) VALUES (?,?,?,?,?)', 'X', '/games/X', 'X', 'X', new Date());
      assert.equal((await get('A')).json().revision, 2);
      assert.equal((await admin('GET')).json().items.length, 0);
      assert.equal((await admin('GET', '/A/X')).statusCode, 404);
      assert.equal((await admin('DELETE', '/A/X', { revision: 2 })).statusCode, 409);
      await prisma.$executeRawUnsafe('DELETE FROM Game WHERE id = ?', 'X');
      assert.equal((await admin('DELETE', '/A/X', { revision: 2 })).statusCode, 200);
      await prisma.user.delete({ where: { id: 'B' } });
      assert.equal(await prisma.saveSyncState.count(), 0);
    });
  } finally {
    await app.close(); await prisma.$disconnect(); rmSync(directory, { recursive: true, force: true });
  }
});
