import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile, lstat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { changePatchSet, patchPreview, patchStorage, validId, cleanPatchDrafts } from '../services/patches.js';
const execute = promisify(execFile);
const inspector = fileURLToPath(new URL('../services/patch_archive.py', import.meta.url));
const limit = 256 * 1024 * 1024;
export default async function patchRoutes(app) {
  app.addHook('preHandler', async (request, reply) => {
    if (request.user?.role !== 'admin') return reply.code(403).send({ message: 'Administrator access required.' });
    if (!/^[a-f0-9]{32}$/.test(request.params.gameId || '')) return reply.code(400).send({ message: 'Invalid game ID.' });
    const game = await app.prisma.game.findUnique({ where: { id: request.params.gameId } });
    if (!game) return reply.code(404).send({ message: 'Game not found.' });
    request.patchGame = game;
  });
  const base = '/games/:gameId/patches';
  app.get(base, async request => {
    const game = request.patchGame;
    const patches = await app.prisma.gamePatch.findMany({ where: { gameId: game.id }, orderBy: { position: 'asc' } });
    return { revision: game.patchRevision, builtRevision: game.builtPatchRevision, needsBuild: game.patchRevision !== game.builtPatchRevision,
      building: ['queued', 'building'].includes(game.buildStatus),
      patches: patches.map(({ manifest, ...patch }) => ({ ...patch, files: JSON.parse(manifest).files.map(file => file.path) })) };
  });
  app.post(base + '/preview', { bodyLimit: limit + 1024 * 1024 }, async (request, reply) => {
    await cleanPatchDrafts(app.prisma, request.patchGame.id);
    const upload = await request.file({ limits: { fileSize: limit, files: 1 } });
    if (!upload) return reply.code(400).send({ message: 'Select a .rpy or .zip patch package.' });
    const name = basename(upload.filename || '');
    if (!/\.(rpy|zip)$/i.test(name)) { upload.file.resume(); return reply.code(400).send({ message: 'Select a .rpy or .zip patch package.' }); }
    const packageId = randomUUID(), folder = join(patchStorage(), request.patchGame.id, packageId);
    await mkdir(join(folder, 'files'), { recursive: true });
    const archive = join(folder, 'upload');
    try {
      await pipeline(upload.file, createWriteStream(archive, { flags: 'wx' }));
      if (upload.file.truncated) throw new Error('Patch upload exceeds 256 MiB.');
      const { stdout } = await execute(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), [inspector, archive, join(folder, 'files'), name], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
      const files = JSON.parse(stdout);
      await writeFile(join(folder, 'package.json'), JSON.stringify({ name, files, createdAt: new Date().toISOString() }));
      await rm(archive);
      return await patchPreview(app.prisma, request.patchGame, packageId);
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      return reply.code(400).send({ message: error.stderr?.trim().slice(-1000) || error.message });
    }
  });
  app.post(base + '/:packageId/preview', async (request, reply) => {
    if (!validId(request.params.packageId)) return reply.code(400).send({ message: 'Invalid patch ID.' });
    return patchPreview(app.prisma, request.patchGame, request.params.packageId, request.body?.root);
  });
  app.post(base, async (request, reply) => {
    const { packageId, root, revision, confirmed } = request.body || {};
    if (!validId(packageId) || confirmed !== true) return reply.code(400).send({ message: 'Review and confirm the patch preview first.' });
    const installed = await app.prisma.gamePatch.findUnique({ where: { id: packageId } });
    if (installed) return installed.gameId === request.patchGame.id ? { ok: true, alreadyInstalled: true } : reply.code(404).send({ message: 'Patch not found.' });
    const preview = await patchPreview(app.prisma, request.patchGame, packageId, root);
    if (!preview.canInstall) return reply.code(400).send({ message: 'Choose a folder containing supported patch files.' });
    await changePatchSet(app.prisma, request.patchGame.id, revision, async tx => {
      if (await tx.gamePatch.count({ where: { gameId: request.patchGame.id } }) >= 50) throw Object.assign(new Error('A game can have up to 50 installed patches.'), { statusCode: 400 });
      const last = await tx.gamePatch.aggregate({ where: { gameId: request.patchGame.id }, _max: { position: true } });
      await writeFile(join(patchStorage(), request.patchGame.id, packageId, '.claimed'), 'retained for build retries');
      await tx.gamePatch.create({ data: { id: packageId, gameId: request.patchGame.id, name: preview.name, position: (last._max.position ?? -1) + 1,
        manifest: JSON.stringify({ files: preview.files.map(({ replaces, conflict, ...file }) => file) }) } });
    });
    return { ok: true };
  });
  app.put(base, async (request, reply) => {
    const { patches, revision, confirmed } = request.body || {};
    const existing = await app.prisma.gamePatch.findMany({ where: { gameId: request.patchGame.id } });
    if (confirmed !== true || !Array.isArray(patches) || patches.some(p => !p || typeof p.id !== 'string') || patches.length !== existing.length || new Set(patches.map(p => p.id)).size !== existing.length ||
        patches.some(p => typeof p.enabled !== 'boolean' || !existing.some(e => e.id === p.id))) return reply.code(400).send({ message: 'Review and confirm the complete patch order.' });
    await changePatchSet(app.prisma, request.patchGame.id, revision, async tx => {
      for (const [position, patch] of patches.entries()) await tx.gamePatch.update({ where: { id: patch.id }, data: { enabled: patch.enabled, position } });
    });
    return { ok: true };
  });
  app.delete(base + '/:packageId', async (request, reply) => {
    if (!validId(request.params.packageId)) return reply.code(400).send({ message: 'Invalid patch ID.' });
    const patch = await app.prisma.gamePatch.findUnique({ where: { id: request.params.packageId } });
    if (patch && patch.gameId !== request.patchGame.id) return reply.code(404).send({ message: 'Patch not found.' });
    if (patch) {
      await changePatchSet(app.prisma, request.patchGame.id, Number(request.query.revision), tx => tx.gamePatch.delete({ where: { id: patch.id } }));
      // Mutations are forbidden while queued/running builds reference this package.
      await rm(join(patchStorage(), request.patchGame.id, patch.id), { recursive: true, force: true });
    } else {
      const folder = join(patchStorage(), request.patchGame.id, request.params.packageId);
      if (!await lstat(join(folder, '.claimed')).catch(() => null)) await rm(folder, { recursive: true, force: true });
    }
    return { ok: true };
  });
}
