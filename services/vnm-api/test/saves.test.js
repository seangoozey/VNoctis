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
      const sql = readFileSync(new URL(`${name}/migration.sql`, migrations), 'utf8');
      for (const statement of sql.split(';').filter(s => s.trim())) await prisma.$executeRawUnsafe(statement);
    }
    await prisma.user.createMany({ data: ['A', 'B'].map(id => ({ id, username: id, passwordHash: 'unused' })) });
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
    await t.test('two concurrent writers cannot overwrite the same revision', async () => {
      const results = await Promise.all([put('A', 1, snapshot('B')), put('A', 1, snapshot('C'))]);
      assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
      assert.equal((await get('A')).json().revision, 2);
      assert.equal((await put('A', 0)).statusCode, 409);
    });
    await t.test('invalid snapshot and oversized body leave server state intact', async () => {
      const copy = snapshot(); copy.files[0].path = '../attack';
      assert.equal((await put('A', 2, copy)).statusCode, 400);
      const huge = snapshot(); huge.files[0].data = 'A'.repeat(46 * 1024 * 1024);
      assert.equal((await put('A', 2, huge)).statusCode, 413);
      assert.equal((await get('A')).json().revision, 2);
    });
    await t.test('build output replacement does not remove saves; game deletion cascades', async () => {
      await prisma.$executeRawUnsafe('UPDATE Game SET webBuildPath = ? WHERE id = ?', '/web-builds/new-version', 'X');
      assert.equal((await get('A')).json().revision, 2);
      await prisma.$executeRawUnsafe('DELETE FROM Game WHERE id = ?', 'X');
      assert.equal(await prisma.saveSyncState.count(), 0);
    });
  } finally {
    await app.close(); await prisma.$disconnect(); rmSync(directory, { recursive: true, force: true });
  }
});
