import { createHash, randomUUID } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
// SQLite has one writer. Queue local save transactions rather than allowing
// competing read-then-write transactions to deadlock under simultaneous uploads.
let writer = Promise.resolve();
export function writeTransaction(prisma, callback) {
  const task = writer.then(() => prisma.$transaction(callback, { maxWait: 10000, timeout: 60000 }));
  writer = task.catch(() => {}); return task;
}
export const saveChecksum = snapshot => digest(JSON.stringify(snapshot.files
  .filter(file => file.path.endsWith('.save')).map(({ path, data }) => [path, data])
  .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
export const canonical = snapshot => ({ version: 1, files: snapshot.files
  .map(({ path, mtime, data }) => ({ path, mtime, data }))
  .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });

export function saveKind(before, after) {
  const previous = new Map(before.files.filter(f => f.path.endsWith('.save')).map(f => [f.path, f.data]));
  const next = new Map(after.files.filter(f => f.path.endsWith('.save')).map(f => [f.path, f.data]));
  const changed = [...new Set([...previous.keys(), ...next.keys()])].filter(path => previous.get(path) !== next.get(path));
  if (!changed.length) return null;
  // Standard Ren'Py names are auto-1-*.save, quick-1-*.save, and numbered slots.
  return changed.every(path => /^auto[-_]/i.test(path.split('/').at(-1))) ? 'auto' : 'manual';
}

export async function archive(tx, snapshot, details) {
  const copy = canonical(snapshot);
  const unique = new Map();
  const files = copy.files.map(file => {
    const bytes = Buffer.from(file.data, 'base64'); const hash = digest(bytes);
    unique.set(hash, bytes); return { path: file.path, mtime: file.mtime, hash };
  });
  const entries = [...unique];
  for (let i = 0; i < entries.length; i += 100) {
    const batch = entries.slice(i, i + 100);
    await tx.$executeRawUnsafe(`INSERT OR IGNORE INTO SaveFileBlob (hash,data,size) VALUES ${batch.map(() => '(?,?,?)').join(',')}`,
      ...batch.flatMap(([hash, bytes]) => [hash, bytes, bytes.length]));
  }
  const id = randomUUID();
  await tx.saveVersion.create({ data: { ...details, id,
    checksum: digest(JSON.stringify(copy)), saveChecksum: saveChecksum(copy),
    byteSize: copy.files.reduce((size, file) => size + Buffer.byteLength(file.data, 'base64'), 0),
  } });
  for (let i = 0; i < files.length; i += 100) {
    await tx.saveVersionFile.createMany({ data: files.slice(i, i + 100).map(file => ({ ...file, versionId: id })) });
  }
  return id;
}

export async function readVersion(tx, id, key) {
  const version = await tx.saveVersion.findFirst({ where: { id, ...key }, include: { files: { include: { blob: true }, orderBy: { path: 'asc' } } } });
  if (!version) return null;
  return { version, snapshot: { version: 1, files: version.files.map(file => ({
    path: file.path, mtime: file.mtime, data: Buffer.from(file.blob.data).toString('base64'),
  })) } };
}

export async function ensureCurrentVersion(tx, state, captureUpdates = false) {
  if (!state) return null;
  const copy = canonical(JSON.parse(state.payload));
  if (state.currentVersionId) {
    const current = await tx.saveVersion.findUnique({ where: { id: state.currentVersionId }, select: { checksum: true } });
    if (current && (!captureUpdates || current.checksum === digest(JSON.stringify(copy)))) return state.currentVersionId;
  }
  const id = await archive(tx, copy, { userId: state.userId, gameId: state.gameId, gameTitle: state.gameTitle,
    kind: 'checkpoint', baseRevision: state.revision, revision: state.revision,
    deviceLabel: 'Synced saves', createdAt: state.updatedAt });
  await tx.saveSyncState.update({ where: { userId_gameId: { userId: state.userId, gameId: state.gameId } }, data: { currentVersionId: id } });
  return id;
}

export function retainedIds(versions, currentId, now = Date.now()) {
  const keep = new Set(currentId ? [currentId] : []);
  const hours = new Set(), days = new Set(); let manual = 0;
  const day = 86400000;
  for (const version of [...versions].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt) || b.id.localeCompare(a.id))) {
    if (version.alternate) { keep.add(version.id); continue; }
    if (version.kind === 'manual' || version.kind === 'restored') {
      if (++manual <= 40) keep.add(version.id);
      continue;
    }
    const timestamp = +new Date(version.createdAt), age = now - timestamp;
    if (age <= day) keep.add(version.id);
    else if (age <= 7 * day) {
      const bucket = Math.floor(timestamp / 3600000);
      if (!hours.has(bucket)) { hours.add(bucket); keep.add(version.id); }
    } else if (age <= 30 * day) {
      const bucket = Math.floor(timestamp / day);
      if (!days.has(bucket)) { days.add(bucket); keep.add(version.id); }
    }
  }
  return keep;
}

export const collectBlobs = tx => tx.$executeRawUnsafe('DELETE FROM SaveFileBlob WHERE NOT EXISTS (SELECT 1 FROM SaveVersionFile f WHERE f.hash = SaveFileBlob.hash)');
export async function prune(tx, key, currentId, now) {
  const versions = await tx.saveVersion.findMany({ where: key, select: { id: true, kind: true, alternate: true, createdAt: true } });
  const keep = retainedIds(versions, currentId, now);
  const remove = versions.filter(version => !keep.has(version.id)).map(version => version.id);
  for (let i = 0; i < remove.length; i += 100) await tx.saveVersion.deleteMany({ where: { ...key, id: { in: remove.slice(i, i + 100) } } });
  await collectBlobs(tx);
}

export async function pruneAll(prisma) {
  const groups = await prisma.saveVersion.groupBy({ by: ['userId', 'gameId'] });
  for (const key of groups) await writeTransaction(prisma, async tx => {
    const state = await tx.saveSyncState.findUnique({ where: { userId_gameId: key }, select: { currentVersionId: true } });
    await prune(tx, key, state?.currentVersionId);
  });
  await writeTransaction(prisma, collectBlobs);
}
