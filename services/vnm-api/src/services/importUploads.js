import { mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { archiveType } from './importJobs.js';

export const IMPORT_CHUNK_BYTES = 16 * 1024 * 1024;
export const IMPORT_UPLOAD_TTL = 24 * 60 * 60 * 1000;
const instances = new WeakMap();
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const checksumPattern = /^[a-f0-9]{64}$/;
const error = (message, statusCode = 400, code = 'INVALID_UPLOAD') => Object.assign(new Error(message), { statusCode, code });

export function getImportUploads(app) {
  if (!instances.has(app.prisma)) instances.set(app.prisma, createImportUploads(app));
  return instances.get(app.prisma);
}
export function createImportUploads(app) {
  const locks = new Map(), prisma = app.prisma;
  const maxBytes = (Number(process.env.MAX_IMPORT_SIZE_MB) || 24576) * 1024 * 1024;
  async function locked(id, action) {
    if (!idPattern.test(id || '')) throw error('Invalid upload ID.');
    const previous = locks.get(id) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    locks.set(id, current);
    await previous;
    try { return await action(); }
    finally { release(); if (locks.get(id) === current) locks.delete(id); }
  }
  const archivePath = upload => join(app.jobRunner.directory(upload.id), 'archive' + archiveType(upload.name));
  function publicState(upload) {
    return { uploadId: upload.id, jobId: upload.id, name: upload.name, size: Number(upload.size),
      offset: Number(upload.offset), checksum: upload.checksum, chunkSize: IMPORT_CHUNK_BYTES,
      status: upload.job.status, stage: upload.job.stage, expiresAt: upload.expiresAt,
      lastActivity: upload.updatedAt, error: upload.lastError || upload.job.error || null };
  }
  async function load(id, ownerId) {
    const upload = await prisma.importUpload.findUnique({ where: { id }, include: { job: true } });
    if (!upload || upload.ownerId !== ownerId) throw error('Upload not found.', 404, 'UPLOAD_NOT_FOUND');
    return upload;
  }
  async function finishIncomplete(upload, status, message) {
    const result = await prisma.workJob.updateMany({ where: { id: upload.id, status: 'uploading' },
      data: { status, stage: status, error: message, completedAt: new Date() } });
    if (!result.count) return false;
    await prisma.importUpload.update({ where: { id: upload.id }, data: { lastError: message } });
    await rm(app.jobRunner.directory(upload.id), { recursive: true, force: true });
    await app.jobRunner.log(upload.id, `[upload] ${message}`);
    return true;
  }
  async function active(upload) {
    if (upload.job.status !== 'uploading') throw error('This upload is no longer accepting chunks. Check its job.', 409, 'UPLOAD_NOT_ACTIVE');
    if (upload.expiresAt.getTime() <= Date.now()) {
      await finishIncomplete(upload, 'failed', 'Upload expired after 24 hours without confirmed progress. Reselect the archive to start again.');
      throw error('Upload expired. Reselect the archive to start again.', 410, 'UPLOAD_EXPIRED');
    }
    const size = await stat(archivePath(upload)).then(info => info.size, () => -1);
    if (size < Number(upload.offset)) throw error('Stored upload data is missing. Start a new upload.', 410, 'UPLOAD_DAMAGED');
  }
  async function recordFailure(id, ownerId, cause, requestId = '') {
    if (!idPattern.test(id || '')) return;
    await locked(id, async () => {
      const upload = await load(id, ownerId);
      if (upload.job.status !== 'uploading') return;
      const message = String(cause.message || cause).slice(0, 500);
      await prisma.importUpload.update({ where: { id }, data: { lastError: message } });
      await prisma.workJob.updateMany({ where: { id, status: 'uploading' }, data: { error: `Upload interrupted at ${Number(upload.offset)} of ${Number(upload.size)} bytes: ${message}` } });
      await app.jobRunner.log(id, `[upload] request=${requestId} interrupted; confirmed=${upload.offset}/${upload.size}; ${message}`);
      app.log.warn({ uploadId: id, requestId, confirmedBytes: Number(upload.offset), totalBytes: Number(upload.size), code: cause.code, error: message }, 'Import upload interrupted');
    }).catch(cause => app.log.warn({ uploadId: id, error: cause.message }, 'Could not record upload failure'));
  }
  return {
    recordFailure,
    limits() { return { maxBytes, chunkSize: IMPORT_CHUNK_BYTES, retentionHours: 24 }; },
    async create(ownerId, input) {
      const { uploadId: id, name, size, checksum } = input || {};
      if (typeof name !== 'string' || !name || name.length > 255 || /[/\\\x00-\x1f]/.test(name) || !archiveType(name) ||
          !Number.isSafeInteger(size) || size <= 0 || size > maxBytes || !checksumPattern.test(checksum || '')) {
        throw error('Select a supported archive within the import size limit and provide its SHA-256 checksum.');
      }
      return locked(id, async () => {
        const existing = await prisma.importUpload.findUnique({ where: { id }, include: { job: true } });
        if (existing) {
          if (existing.ownerId !== ownerId) throw error('Upload not found.', 404, 'UPLOAD_NOT_FOUND');
          if (existing.name !== name || Number(existing.size) !== size || existing.checksum !== checksum) throw error('Upload ID belongs to a different archive.', 409, 'UPLOAD_ID_CONFLICT');
          return publicState(existing);
        }
        if (await prisma.workJob.findUnique({ where: { id } })) throw error('Upload ID is already in use.', 409, 'UPLOAD_ID_CONFLICT');
        if (await prisma.importUpload.count({ where: { ownerId, expiresAt: { gt: new Date() }, job: { status: 'uploading' } } }) >= 10) {
          throw error('There are already 10 unfinished uploads. Resume or cancel one in Jobs.', 409, 'UPLOAD_LIMIT');
        }
        const directory = app.jobRunner.directory(id);
        await mkdir(dirname(directory), { recursive: true });
        try { await mkdir(directory); }
        catch (cause) { if (cause.code === 'EEXIST') throw error('Upload ID is already in use. Start a new upload.', 409, 'UPLOAD_ID_CONFLICT'); throw cause; }
        try {
          const archive = join(directory, 'archive' + archiveType(name));
          const file = await open(archive, 'wx');
          try { await file.sync(); } finally { await file.close(); }
          // Persist the file's directory entry as well as its contents on Linux.
          if (process.platform !== 'win32') {
            for (const path of [directory, dirname(directory), dirname(dirname(directory))]) { const folder = await open(path, 'r'); try { await folder.sync(); } finally { await folder.close(); } }
          }
          const upload = await prisma.$transaction(async tx => {
            await tx.workJob.create({ data: { id, kind: 'import', ownerId, title: name, status: 'uploading', stage: 'uploading',
              bytesTotal: BigInt(size), startedAt: new Date(), input: JSON.stringify({ name, archive, expectedHash: checksum, uploadPending: true }) } });
            return tx.importUpload.create({ data: { id, ownerId, name, size: BigInt(size), checksum, expiresAt: new Date(Date.now() + IMPORT_UPLOAD_TTL) }, include: { job: true } });
          });
          await app.jobRunner.log(id, `[upload] Created upload ${id}: ${name}; total=${size}; maxChunk=${IMPORT_CHUNK_BYTES}`);
          app.log.info({ uploadId: id, totalBytes: size }, 'Resumable import upload created');
          return publicState(upload);
        } catch (cause) {
          // A lost log acknowledgement must not remove an already committed upload.
          if (!await prisma.importUpload.findUnique({ where: { id } }).catch(() => true)) await rm(directory, { recursive: true, force: true });
          throw cause;
        }
      });
    },
    async list(ownerId) {
      return (await prisma.importUpload.findMany({ where: { ownerId, expiresAt: { gt: new Date() }, job: { status: 'uploading' } },
        include: { job: true }, orderBy: { updatedAt: 'desc' }, take: 10 })).map(publicState);
    },
    async get(id, ownerId) {
      return locked(id, async () => publicState(await load(id, ownerId)));
    },
    async chunk(id, ownerId, offset, body, checksum, requestId = '') {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Buffer.isBuffer(body) || !body.length || body.length > IMPORT_CHUNK_BYTES || !checksumPattern.test(checksum || '')) throw error('Invalid upload offset, chunk size or checksum.');
      if (createHash('sha256').update(body).digest('hex') !== checksum) throw error('Chunk checksum mismatch. No bytes were accepted.', 422, 'CHUNK_CHECKSUM_MISMATCH');
      return locked(id, async () => {
        const started = Date.now(), upload = await load(id, ownerId);
        await active(upload);
        const confirmed = Number(upload.offset);
        if (offset > confirmed || offset + body.length > Number(upload.size)) throw error(`Upload offset mismatch; server has confirmed ${confirmed} bytes.`, 409, 'UPLOAD_OFFSET_MISMATCH');
        const file = await open(archivePath(upload), 'r+');
        try {
          if (offset < confirmed) {
            if (offset + body.length > confirmed) throw error('Chunk overlaps confirmed progress.', 409, 'UPLOAD_OFFSET_MISMATCH');
            const previous = Buffer.alloc(body.length);
            let read = 0;
            while (read < previous.length) { const result = await file.read(previous, read, previous.length - read, offset + read); if (!result.bytesRead) throw error('Stored upload data is incomplete.', 410, 'UPLOAD_DAMAGED'); read += result.bytesRead; }
            if (createHash('sha256').update(previous).digest('hex') !== checksum) throw error('Retry bytes do not match the confirmed chunk.', 409, 'UPLOAD_CHUNK_CONFLICT');
            return publicState(upload);
          }
          // A crash after disk sync but before ledger commit may leave an unconfirmed tail.
          await file.truncate(confirmed);
          let written = 0;
          while (written < body.length) { const result = await file.write(body, written, body.length - written, confirmed + written); if (!result.bytesWritten) throw new Error('Could not write upload chunk.'); written += result.bytesWritten; }
          await file.sync();
          const next = confirmed + body.length;
          await prisma.$transaction(async tx => {
            const changed = await tx.importUpload.updateMany({ where: { id, offset: BigInt(confirmed) }, data: { offset: BigInt(next), lastError: null, expiresAt: new Date(Date.now() + IMPORT_UPLOAD_TTL) } });
            const job = await tx.workJob.updateMany({ where: { id, status: 'uploading' }, data: { stage: 'uploading', bytesDone: BigInt(next), error: null } });
            if (!changed.count || !job.count) throw error('Upload changed while receiving this chunk.', 409, 'UPLOAD_OFFSET_MISMATCH');
          });
          app.log.info({ uploadId: id, requestId, offset: confirmed, bytes: body.length, confirmedBytes: next, totalBytes: Number(upload.size), elapsedMs: Date.now() - started }, 'Import chunk confirmed');
          await app.jobRunner.log(id, `[upload] request=${requestId} confirmed=${next}/${upload.size}; chunk=${body.length}; diskAndCommitMs=${Date.now() - started}`);
          return publicState(await load(id, ownerId));
        } finally { await file.close(); }
      });
    },
    async complete(id, ownerId) {
      return locked(id, async () => {
        const upload = await load(id, ownerId);
        if (!['uploading', 'cancelled', 'failed'].includes(upload.job.status)) return publicState(upload);
        await active(upload);
        if (upload.offset !== upload.size) throw error('The server has not received the complete archive.', 409, 'UPLOAD_INCOMPLETE');
        const changed = await prisma.workJob.updateMany({ where: { id, status: 'uploading' }, data: { status: 'queued', stage: 'verifying', error: null,
          input: JSON.stringify({ name: upload.name, archive: archivePath(upload), expectedHash: upload.checksum, uploadPending: false }) } });
        if (changed.count) { await app.jobRunner.log(id, '[upload] All bytes confirmed. Queued checksum verification and import.'); app.jobRunner.wake(); }
        return publicState(await load(id, ownerId));
      });
    },
    async cancel(id, ownerId) {
      return locked(id, async () => finishIncomplete(await load(id, ownerId), 'cancelled', 'Upload cancelled. Staged bytes removed.'));
    },
    async cleanup() {
      const expired = await prisma.importUpload.findMany({ where: { expiresAt: { lte: new Date() }, job: { status: 'uploading' } }, take: 100 });
      for (const upload of expired) await locked(upload.id, async () => {
        const current = await load(upload.id, upload.ownerId);
        if (current.expiresAt.getTime() <= Date.now()) await finishIncomplete(current, 'failed', 'Upload expired after 24 hours without confirmed progress. Reselect the archive to start again.');
      });
    },
    async stop() { await Promise.allSettled([...locks.values()]); },
  };
}
