import { createHash } from 'node:crypto';
import { archive, canonical, collectBlobs, digest, ensureCurrentVersion, prune, pruneAll, readVersion, saveChecksum, saveKind, writeTransaction } from '../services/saveHistory.js';

export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

// Never deserialize Ren'Py saves or write client-supplied paths on the server.
export function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.files) || snapshot.files.length > 4096) return false;
  const paths = new Set();
  let bytes = 0;
  for (const file of snapshot.files) {
    if (!file || typeof file.path !== 'string' || file.path.length > 512 ||
        !file.path || file.path.split('/').some(p => !p || p === '.' || p === '..') ||
        /[\\\x00-\x1f]/.test(file.path) || paths.has(file.path) ||
        !Number.isSafeInteger(file.mtime) || file.mtime < 0 || file.mtime > 8640000000000000 ||
        typeof file.data !== 'string' || file.data.length > MAX_SNAPSHOT_BYTES * 4 / 3 ||
        file.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(file.data) ||
        file.data.slice(0, -2).includes('=') ||
        (file.data.at(-2) === '=' && file.data.at(-1) !== '=')) return false;
    paths.add(file.path);
    bytes += Buffer.byteLength(file.data, 'base64');
    if (bytes > MAX_SNAPSHOT_BYTES) return false;
  }
  // A file cannot also be an ancestor directory.
  for (const path of paths) {
    const parts = path.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (paths.has(parts.join('/'))) return false;
    }
  }
  return true;
}

export default async function savesRoutes(fastify) {
  let retentionTimer, retentionTask = null;
  fastify.addHook('onReady', async () => {
    await pruneAll(fastify.prisma);
    retentionTimer = setInterval(() => {
      if (retentionTask) return;
      retentionTask = pruneAll(fastify.prisma)
        .catch(err => fastify.log.error({ err }, 'Save history retention failed'))
        .finally(() => { retentionTask = null; });
    }, 3600000);
    retentionTimer.unref();
  });
  fastify.addHook('onClose', async () => { clearInterval(retentionTimer); await retentionTask; });
  const options = {
    bodyLimit: 46 * 1024 * 1024,
    onRequest: async request => { request.saveStartedAt = performance.now(); },
    schema: { params: { type: 'object', required: ['gameId'], properties: {
      gameId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
    } }, querystring: { type: 'object', properties: { uploadId: { type: 'string', maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' } } } },
    preHandler: async (request, reply) => {
      if (!request.user?.userId) return reply.code(401).send({ message: 'Authentication required' });
      // VNoctis shares its library with all authenticated users, including hidden games.
      const game = await fastify.prisma.game.findUnique({ where: { id: request.params.gameId }, select: { id: true, extractedTitle: true } });
      if (!game) return reply.code(404).send({ message: 'Game not found' });
      request.saveGameTitle = game.extractedTitle;
      reply.header('Cache-Control', 'no-store');
    },
  };
  fastify.get('/games/:gameId/saves', options, async request => {
    const state = await fastify.prisma.saveSyncState.findUnique({ where: {
      userId_gameId: { userId: request.user.userId, gameId: request.params.gameId },
    } });
    const key = { userId: request.user.userId, gameId: request.params.gameId };
    const acknowledgement = request.query.uploadId ? await fastify.prisma.saveUploadReceipt.findUnique({ where: {
      userId_gameId_uploadId: { ...key, uploadId: request.query.uploadId },
    } }) : null;
    const snapshot = state ? JSON.parse(state.payload) : null;
    return { revision: state?.revision || 0, checksum: state?.checksum, uploadId: state?.uploadId,
      currentVersionId: state?.currentVersionId, snapshot, saveChecksum: saveChecksum(snapshot || { files: [] }),
      acknowledgement: acknowledgement ? receiptResponse(acknowledgement, state?.revision || 0) : null };
  });
  fastify.put('/games/:gameId/saves', options, async (request, reply) => {
    const timings = {};
    let measuredAt = request.saveStartedAt ?? performance.now();
    const startedAt = measuredAt;
    const mark = name => {
      const now = performance.now();
      timings[name] = Math.round((now - measuredAt) * 10) / 10;
      measuredAt = now;
    };
    mark('beforeHandlerMs');
    const { revision, snapshot, uploadId = null, baseSaveChecksum = null, alternate = false, branchId = null, deviceLabel = 'Browser' } = request.body || {};
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= 2147483647 || !validateSnapshot(snapshot) ||
        (uploadId !== null && (typeof uploadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uploadId))) ||
        (baseSaveChecksum !== null && (typeof baseSaveChecksum !== 'string' || !/^[a-f0-9]{64}$/.test(baseSaveChecksum))) ||
        (branchId !== null && (typeof branchId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(branchId))) ||
        typeof alternate !== 'boolean' || typeof deviceLabel !== 'string' || !deviceLabel || deviceLabel.length > 80 || /[\x00-\x1f]/.test(deviceLabel)) {
      return reply.code(400).send({ message: 'Invalid save snapshot' });
    }
    const copy = canonical(snapshot);
    const payload = JSON.stringify(copy);
    const checksum = createHash('sha256').update(payload).digest('hex');
    const key = { userId: request.user.userId, gameId: request.params.gameId };
    const id = uploadId || digest(`${revision}:${payload}`);
    mark('validateAndHashMs');
    const result = await writeTransaction(fastify.prisma, async tx => {
      mark('queueAndBeginMs');
      const state = await tx.saveSyncState.findUnique({ where: { userId_gameId: key } });
      const receipt = await tx.saveUploadReceipt.findUnique({ where: { userId_gameId_uploadId: { ...key, uploadId: id } } });
      mark('readStateMs');
      if (receipt) return receipt.checksum === checksum ? receiptResponse(receipt, state?.revision || 0)
        : { error: 'Upload ID already used for different save data.' };
      const previous = state ? canonical(JSON.parse(state.payload)) : { version: 1, files: [] };
      // Import an old acknowledged request when upgrading from the earlier bridge.
      if (state?.uploadId === id && digest(JSON.stringify(previous)) === checksum) {
        const imported = await tx.saveUploadReceipt.create({ data: { ...key, uploadId: id, checksum,
          revision: state.revision, disposition: 'current', saveChecksum: saveChecksum(copy) } });
        return receiptResponse(imported, state.revision);
      }
      const incomingSlots = saveChecksum(copy), serverSlots = saveChecksum(previous);
      const divergent = Boolean(state && (alternate || (revision !== state.revision &&
        baseSaveChecksum !== serverSlots && incomingSlots !== serverSlots)));
      const kind = saveKind(previous, copy);
      mark('compareMs');
      // Existing saves are archived lazily before their first replacement.
      let currentVersionId = state?.currentVersionId || null;
      if (state && (kind || divergent || !currentVersionId)) currentVersionId = await ensureCurrentVersion(tx, state);
      mark('ensureHistoryMs');
      const nextRevision = divergent ? revision : (state?.revision || 0) + 1;
      const continuation = divergent ? branchId || id : null;
      let versionId = null;
      if (kind || divergent || !state) {
        versionId = await archive(tx, copy, { ...key, gameTitle: request.saveGameTitle,
          kind: kind || 'checkpoint', alternate: Boolean(divergent), branchId: continuation, baseRevision: revision,
          revision: nextRevision, deviceLabel });
      }
      mark('archiveMs');
      if (!divergent) {
        if (versionId) currentVersionId = versionId;
        const data = { payload, checksum, uploadId: id, gameTitle: request.saveGameTitle, revision: nextRevision, currentVersionId };
        await tx.saveSyncState.upsert({ where: { userId_gameId: key }, create: { ...key, ...data }, update: data });
      }
      mark('writeCurrentMs');
      const accepted = await tx.saveUploadReceipt.create({ data: { ...key, uploadId: id, checksum,
        revision: nextRevision, disposition: divergent ? 'alternate' : 'current', versionId, branchId: continuation,
        saveChecksum: incomingSlots } });
      mark('receiptMs');
      if (versionId) await prune(tx, key, currentVersionId);
      mark('pruneMs');
      return receiptResponse(accepted, divergent ? state?.revision || 0 : nextRevision);
    });
    mark('commitMs');
    const totalMs = Math.round((performance.now() - startedAt) * 10) / 10;
    if (totalMs >= 500) request.log.info({ saveTiming: { totalMs, ...timings,
      files: copy.files.length, snapshotBytes: Buffer.byteLength(payload),
    } }, 'Slow save upload');
    return result.error ? reply.code(409).send({ message: result.error }) : result;
  });

  const historyOptions = { ...options, schema: { ...options.schema, querystring: { type: 'object', properties: {
    offset: { type: 'integer', minimum: 0, maximum: 2147483647, default: 0 },
  } } } };
  fastify.get('/games/:gameId/saves/history', historyOptions, async request => {
    const key = { userId: request.user.userId, gameId: request.params.gameId };
    return writeTransaction(fastify.prisma, async tx => {
      const state = await tx.saveSyncState.findUnique({ where: { userId_gameId: key } });
      const currentVersionId = await ensureCurrentVersion(tx, state);
      await prune(tx, key, currentVersionId);
      const versions = await tx.saveVersion.findMany({ where: key, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: request.query.offset, take: 51, select: { id: true, kind: true, alternate: true, baseRevision: true,
          revision: true, deviceLabel: true, createdAt: true, byteSize: true, restoredFrom: true } });
      return { currentRevision: state?.revision || 0, currentVersionId,
        versions: versions.slice(0, 50), nextOffset: versions.length > 50 ? request.query.offset + 50 : null };
    });
  });
  const versionOptions = { ...options, schema: { params: { ...options.schema.params,
    required: ['gameId', 'versionId'], properties: { ...options.schema.params.properties,
      versionId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
    } } } };
  fastify.get('/games/:gameId/saves/history/:versionId', versionOptions, async (request, reply) => {
    const key = { userId: request.user.userId, gameId: request.params.gameId };
    const copy = await readVersion(fastify.prisma, request.params.versionId, key);
    if (!copy) return reply.code(404).send({ message: 'Save version not found' });
    return { version: 1, ...key, gameTitle: copy.version.gameTitle, createdAt: copy.version.createdAt,
      snapshot: copy.snapshot };
  });
  fastify.post('/games/:gameId/saves/history/:versionId/restore', { ...versionOptions, schema: { ...versionOptions.schema,
    body: { type: 'object', required: ['revision', 'uploadId'], properties: {
      revision: { type: 'integer', minimum: 0, maximum: 2147483646 },
      uploadId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
    } } },
  }, async (request, reply) => {
    const key = { userId: request.user.userId, gameId: request.params.gameId };
    const result = await writeTransaction(fastify.prisma, async tx => {
      const state = await tx.saveSyncState.findUnique({ where: { userId_gameId: key } });
      const id = request.body.uploadId, marker = digest(`restore:${request.params.versionId}`);
      const receipt = await tx.saveUploadReceipt.findUnique({ where: { userId_gameId_uploadId: { ...key, uploadId: id } } });
      if (receipt) return receipt.checksum === marker ? receiptResponse(receipt, state?.revision || 0) : { error: 'Upload ID already used' };
      if ((state?.revision || 0) !== request.body.revision) return { error: 'Synced saves changed. Refresh history before restoring.' };
      const selected = await readVersion(tx, request.params.versionId, key);
      if (!selected) return { missing: true };
      if (state) await ensureCurrentVersion(tx, state, true);
      const revision = (state?.revision || 0) + 1;
      const versionId = await archive(tx, selected.snapshot, { ...key, gameTitle: request.saveGameTitle,
        kind: 'restored', baseRevision: state?.revision || 0, revision, deviceLabel: 'Restored in launcher',
        restoredFrom: selected.version.id });
      const payload = JSON.stringify(canonical(selected.snapshot));
      const data = { payload, checksum: digest(payload), revision, uploadId: id,
        currentVersionId: versionId, gameTitle: request.saveGameTitle };
      await tx.saveSyncState.upsert({ where: { userId_gameId: key }, create: { ...key, ...data }, update: data });
      if (selected.version.alternate) await tx.saveVersion.updateMany({ where: { ...key,
        ...(selected.version.branchId ? { branchId: selected.version.branchId } : { id: selected.version.id }),
      }, data: { alternate: false } });
      const accepted = await tx.saveUploadReceipt.create({ data: { ...key, uploadId: id, checksum: marker,
        revision, disposition: 'current', versionId, saveChecksum: saveChecksum(selected.snapshot) } });
      await prune(tx, key, versionId);
      return receiptResponse(accepted, revision);
    });
    if (result.missing) return reply.code(404).send({ message: 'Save version not found' });
    return result.error ? reply.code(409).send({ message: result.error }) : result;
  });
  fastify.delete('/games/:gameId/saves/history/:versionId', versionOptions, async (request, reply) => {
    const key = { userId: request.user.userId, gameId: request.params.gameId };
    const result = await writeTransaction(fastify.prisma, async tx => {
      const state = await tx.saveSyncState.findUnique({ where: { userId_gameId: key } });
      if (state?.currentVersionId === request.params.versionId) return { error: 'The current save version cannot be deleted.' };
      const deleted = await tx.saveVersion.deleteMany({ where: { ...key, id: request.params.versionId } });
      if (deleted.count) await collectBlobs(tx);
      return { deleted: Boolean(deleted.count) };
    });
    if (result.error) return reply.code(409).send({ message: result.error });
    if (!result.deleted) return reply.code(404).send({ message: 'Save version not found' });
    return result;
  });

  // Each admin operation checks the authoritative database role as well as auth.
  const admin = { preHandler: async (request, reply) => {
    if (!request.user?.userId) return reply.code(401).send({ message: 'Authentication required' });
    const user = await fastify.prisma.user.findUnique({ where: { id: request.user.userId }, select: { role: true } });
    if (user?.role !== 'admin') return reply.code(403).send({ message: 'Administrator role required' });
    reply.header('Cache-Control', 'no-store');
  } };
  fastify.get('/admin/orphaned-saves', {
    ...admin, schema: { querystring: { type: 'object', properties: { offset: { type: 'integer', minimum: 0, maximum: 2147483647, default: 0 } } } },
  }, async request => {
    const rows = await fastify.prisma.$queryRaw`
      SELECT s.userId, s.gameId, s.gameTitle, s.revision, s.updatedAt, u.username,
             length(s.payload) AS storedBytes
      FROM SaveSyncState s JOIN User u ON u.id = s.userId
      WHERE NOT EXISTS (SELECT 1 FROM Game g WHERE g.id = s.gameId)
      ORDER BY s.updatedAt DESC, s.userId, s.gameId LIMIT 51 OFFSET ${request.query.offset}`;
    return { items: rows.slice(0, 50).map(row => ({ ...row, storedBytes: Number(row.storedBytes) })),
      nextOffset: rows.length > 50 ? request.query.offset + 50 : null };
  });
  const orphanOptions = { ...admin, schema: { params: { type: 'object', required: ['userId', 'gameId'], properties: {
    userId: { type: 'string', minLength: 1, maxLength: 128 },
    gameId: options.schema.params.properties.gameId,
  } } } };
  fastify.get('/admin/orphaned-saves/:userId/:gameId', orphanOptions, async (request, reply) => {
    const { userId, gameId } = request.params;
    const rows = await fastify.prisma.$queryRaw`
      SELECT s.* FROM SaveSyncState s WHERE s.userId = ${userId} AND s.gameId = ${gameId}
      AND NOT EXISTS (SELECT 1 FROM Game g WHERE g.id = s.gameId)`;
    if (!rows.length) return reply.code(404).send({ message: 'Orphaned saves not found. The game may have returned.' });
    const state = rows[0];
    return { version: 1, userId, gameId, gameTitle: state.gameTitle, revision: state.revision,
      snapshot: JSON.parse(state.payload) };
  });
  fastify.delete('/admin/orphaned-saves/:userId/:gameId', {
    ...orphanOptions, schema: { ...orphanOptions.schema, body: { type: 'object', required: ['revision'], properties: {
      revision: { type: 'integer', minimum: 1, maximum: 2147483647 },
    } } },
  }, async (request, reply) => {
    const { userId, gameId } = request.params;
    // One atomic statement prevents a stale dialog from purging a returned game.
    const count = await writeTransaction(fastify.prisma, async tx => {
      const removed = await tx.$executeRaw`
      DELETE FROM SaveSyncState WHERE userId = ${userId} AND gameId = ${gameId}
      AND revision = ${request.body.revision}
      AND NOT EXISTS (SELECT 1 FROM Game g WHERE g.id = SaveSyncState.gameId)`;
      if (removed) {
        await tx.saveVersion.deleteMany({ where: { userId, gameId } });
        await tx.saveUploadReceipt.deleteMany({ where: { userId, gameId } });
        await collectBlobs(tx);
      }
      return removed;
    });
    if (count !== 1) return reply.code(409).send({ message: 'Saves changed or the game returned. Refresh the list.' });
    return { deleted: true };
  });
}

function receiptResponse(receipt, serverRevision) {
  return { revision: receipt.revision, serverRevision, checksum: receipt.checksum,
    disposition: receipt.disposition, versionId: receipt.versionId, branchId: receipt.branchId, saveChecksum: receipt.saveChecksum };
}
