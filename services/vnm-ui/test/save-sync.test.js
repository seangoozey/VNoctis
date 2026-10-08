import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const source = readFileSync(new URL('../public/save-sync.js', import.meta.url), 'utf8');
const root = '/home/web_user/.renpy';
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
const saveHash = copy => createHash('sha256').update(JSON.stringify((copy?.files || [])
  .filter(file => file.path.endsWith('.save')).map(file => [file.path, file.data])
  .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex');

// Model the IDBFS populate/flush boundary rather than Ren'Py save semantics.
function browser(server, databases, { user = 'A', game = 'X', metadata = new Map(), choices = [] } = {}) {
  server.receipts ||= new Map(); server.alternates ||= [];
  server.uploads ||= [];
  const files = new Map(); const dirs = new Set([root]); const statuses = [];
  const events = [];
  const backups = new Map();
  let interval, offline = false, encodings = 0;
  let nextUploadGate;
  let loseResponse = false;
  const listeners = new Map(); const documentListeners = new Map();
  const timers = new Map(); let timerId = 0;
  const token = `header.${Buffer.from(JSON.stringify({ userId: user })).toString('base64url')}.signature`;
  metadata.set('vnm-token', token);
  const namespace = `vnm-saves:${user}:${game}`;
  const fs = {
    readdir: path => ['.', '..', ...new Set([...dirs, ...files.keys()].filter(p => p.startsWith(`${path}/`)).map(p => p.slice(path.length + 1).split('/')[0]))],
    stat: path => ({ mode: dirs.has(path) ? 0o40777 : 0o100666, mtime: new Date(files.get(path)?.mtime || 0) }),
    isDir: mode => (mode & 0o170000) === 0o40000,
    isFile: mode => (mode & 0o170000) === 0o100000,
    readFile: path => files.get(path).bytes,
    writeFile: (path, bytes) => { files.set(path, { bytes: new Uint8Array(bytes), mtime: 1234 }); fs.close({ path, flags: 1 }); },
    close() {},
    rename: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    mkdirTree: path => { const parts = path.split('/'); while (parts.length) { dirs.add(parts.join('/')); parts.pop(); } },
    utime: (path, atime, mtime) => { files.get(path).mtime = mtime; },
    unlink: path => files.delete(path), rmdir: path => dirs.delete(path),
    syncfs: (populate, callback) => context.IDBFS.getDB(root, (err, db) => {
      if (populate) {
        files.clear(); for (const [path, value] of db.files) { fs.mkdirTree(path.slice(0, path.lastIndexOf('/'))); files.set(path, value); }
      } else db.files = new Map(files);
      callback(err);
    }),
  };
  const context = {
    location: { search: `?vnmGame=${game}&vnmUser=${user}`, origin: 'https://vnm.test' },
    URLSearchParams, Uint8Array, AbortSignal, console, setTimeout, clearTimeout,
    atob: s => Buffer.from(s, 'base64').toString('binary'), btoa: s => { encodings++; return Buffer.from(s, 'binary').toString('base64'); },
    localStorage: { getItem: key => metadata.get(key) ?? null, setItem: (key, value) => metadata.set(key, value) },
    parent: { postMessage: data => { statuses.push(data.message); events.push(data); } },
    Module: { FS: fs },
    IDBFS: { getDB: (name, callback) => {
      if (!databases.has(name)) databases.set(name, { files: new Map() });
      const db = databases.get(name);
      db.transaction = () => {
        const tx = { objectStore: () => ({ openCursor: () => {
          const req = {}; const entries = [...db.files]; let index = 0;
          const next = () => queueMicrotask(() => {
            const item = entries[index++];
            req.result = item ? { key: item[0], value: { contents: item[1].bytes, timestamp: new Date(item[1].mtime) }, continue: next } : null;
            req.onsuccess(); if (!item) tx.oncomplete();
          }); next(); return req;
        } }) }; return tx;
      };
      callback(null, db);
    } },
    setInterval: callback => { interval = callback; timers.set(++timerId, callback); return timerId; },
    clearInterval: id => timers.delete(id),
    addEventListener: (event, callback) => listeners.set(event, callback),
    document: { visibilityState: 'visible', addEventListener: (event, callback) => documentListeners.set(event, callback), createElement: tag => ({ style: {}, append() {}, remove() {}, tag }), body: {
      append: panel => { /* replaced below to capture actual buttons */ },
    } },
    indexedDB: { open: name => {
      const req = {};
      if (!databases.has(name)) databases.set(name, { files: new Map() });
      const storage = name === 'vnm-save-backups' ? backups : databases.get(name).files;
      queueMicrotask(() => {
        req.result = { close() {}, transaction: storeName => {
          const storeKey = key => name === 'vnm-save-outbox' ? `${storeName}:${key}` : key;
          const action = (operation, key, value) => {
            const result = { result: undefined };
            queueMicrotask(() => {
              if (operation === 'put') storage.set(storeKey(key), JSON.parse(JSON.stringify(value)));
              if (operation === 'delete') storage.delete(storeKey(key));
              if (operation === 'get') result.result = storage.get(storeKey(key));
              tx.oncomplete();
            }); return result;
          };
          const tx = { objectStore: () => ({
            put: (copy, key) => action('put', key, copy),
            get: key => action('get', key), delete: key => action('delete', key),
          }) }; return tx;
        } }; req.onsuccess();
      }); return req;
    } },
    fetch: async (url, options) => {
      if (offline) throw new Error('network down');
      const key = `${user}:${game}`;
      const state = server.get(key) || { revision: 0, snapshot: null };
      if (options.method === 'GET') {
        const id = new URLSearchParams(url.split('?')[1] || '').get('uploadId');
        return { ok: true, status: 200, json: async () => ({ ...state, deltaUploads: server.deltaUploads !== false, saveChecksum: saveHash(state.snapshot),
          acknowledgement: server.receipts.get(`${key}:${id}`)?.response || null }) };
      }
      const body = JSON.parse(options.body);
      server.uploads.push(structuredClone(body));
      const identity = JSON.stringify(body.delta || body.snapshot);
      const receiptKey = `${key}:${body.uploadId}`, receipt = server.receipts.get(receiptKey);
      if (receipt) {
        if (receipt.payload !== identity) return { ok: false, status: 409, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => receipt.response };
      }
      if (body.delta) {
        if (body.alternate || body.revision !== state.revision) return { ok: false, status: 409,
          json: async () => ({ code: 'SAVE_BASE_CHANGED', message: 'Server changed' }) };
        const files = new Map((state.snapshot?.files || []).map(file => [file.path, file]));
        for (const path of body.delta.deleted) files.delete(path);
        for (const file of body.delta.files) files.set(file.path, file);
        body.snapshot = { version: 1, files: [...files.values()] };
      }
      const alternate = state.snapshot && (body.alternate || (state.revision !== body.revision &&
        body.baseSaveChecksum !== saveHash(state.snapshot) && saveHash(body.snapshot) !== saveHash(state.snapshot)));
      const next = { revision: alternate ? body.revision : state.revision + 1, snapshot: body.snapshot, uploadId: body.uploadId };
      const branchId = alternate ? body.branchId || body.uploadId : null;
      if (alternate) server.alternates.push({ key, branchId, snapshot: body.snapshot });
      else server.set(key, next);
      const response = { revision: next.revision, disposition: alternate ? 'alternate' : 'current', branchId, saveChecksum: saveHash(body.snapshot) };
      server.receipts.set(receiptKey, { payload: identity, response });
      if (loseResponse) { loseResponse = false; throw new Error('response lost after commit'); }
      const gate = nextUploadGate; nextUploadGate = null;
      if (gate) await gate;
      return { ok: true, status: 200, json: async () => response };
    },
  };
  const buttons = [];
  context.document.createElement = tag => ({ style: {}, append(child) { if (child.tag === 'button') buttons.push(child); }, remove() {}, tag });
  context.document.body.append = () => { const index = choices.shift() ?? 0; queueMicrotask(() => buttons.splice(0)[index].onclick()); };
  context.window = context;
  vm.createContext(context); vm.runInContext(source, context);
  return {
    fs, statuses, events, metadata, namespace, backups,
    encodedCount: () => encodings,
    offline: value => { offline = value; },
    pauseNextUpload() { let release; nextUploadGate = new Promise(resolve => { release = resolve; }); return release; },
    loseNextResponse() { loseResponse = true; },
    activeTimers: () => timers.size,
    async event(name) { listeners.get(name)?.(); await settle(); },
    async visibility(state) { context.document.visibilityState = state; documentListeners.get('visibilitychange')?.(); await settle(); },
    async start() { context.Module.preInit.at(-1)(); await new Promise(resolve => fs.syncfs(true, resolve)); await settle(); },
    async flush() { await new Promise(resolve => fs.syncfs(false, resolve)); await settle(); },
    async save(data = 'progress') { fs.mkdirTree(`${root}/game`); fs.writeFile(`${root}/game/1.save`, Buffer.from(data)); await new Promise(resolve => fs.syncfs(false, resolve)); await settle(); await interval(); await settle(); },
    async retry() { await interval(); await settle(); },
  };
}

test('device handoff retains complete files and isolates users and games', async () => {
  const server = new Map();
  const a = browser(server, new Map()); await a.start(); await a.save();
  const b = browser(server, new Map()); await b.start();
  assert.equal(Buffer.from(b.fs.readFile(`${root}/game/1.save`)).toString(), 'progress');
  const otherUser = browser(server, new Map(), { user: 'B' }); await otherUser.start();
  assert.equal(otherUser.fs.readdir(root).length, 2);
  const otherGame = browser(server, new Map(), { game: 'Y' }); await otherGame.start();
  assert.equal(otherGame.fs.readdir(root).length, 2);
  assert.ok(a.statuses.includes('Saves synced'));
});

test('offline writes survive reload and resume against the acknowledged revision', async () => {
  const server = new Map(), databases = new Map(), metadata = new Map();
  const a = browser(server, databases, { metadata }); await a.start(); await a.save('first');
  a.offline(true); await a.save('offline');
  assert.equal(server.get('A:X').revision, 1);
  const reload = browser(server, databases, { metadata }); reload.offline(true); await reload.start();
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'offline');
  reload.offline(false); await reload.retry();
  assert.equal(server.get('A:X').revision, 2);
});

test('competing sessions preserve the rejected browser copy', async () => {
  const server = new Map();
  const a = browser(server, new Map()); await a.start(); await a.save('initial');
  const b = browser(server, new Map()); await b.start();
  await a.save('winner'); await b.save('conflicting');
  assert.equal(server.get('A:X').revision, 2);
  assert.equal(Buffer.from(b.fs.readFile(`${root}/game/1.save`)).toString(), 'conflicting');
  assert.ok(b.statuses.includes('Save backed up as alternate version'));
  assert.equal(server.alternates.length, 1);
  await b.save('alternate continuation');
  assert.equal(server.alternates.length, 2);
  assert.equal(server.alternates[0].branchId, server.alternates[1].branchId);
  await b.retry(); assert.equal(server.get('A:X').revision, 2);
});

test('explicit legacy import copies only the selected game plus signing keys', async () => {
  const server = new Map(), databases = new Map();
  databases.set(root, { files: new Map([
    [`${root}/old-game/1.save`, { bytes: Buffer.from('legacy'), mtime: 1000 }],
    [`${root}/other-game/1.save`, { bytes: Buffer.from('other'), mtime: 1000 }],
    [`${root}/tokens/security_keys.txt`, { bytes: Buffer.from('keys'), mtime: 1000 }],
  ]) });
  const a = browser(server, databases, { choices: [1] }); await a.start();
  const files = server.get('A:X').snapshot.files;
  assert.deepEqual(files.map(f => f.path).sort(), ['old-game/1.save', 'tokens/security_keys.txt']);
  assert.equal(databases.get(root).files.size, 3);
});

test('declining legacy import leaves original saves untouched', async () => {
  const databases = new Map([[root, { files: new Map([[`${root}/old/1.save`, { bytes: Buffer.from('legacy'), mtime: 1 }]]) }]]);
  const server = new Map(); const a = browser(server, databases); await a.start();
  assert.equal(server.size, 0); assert.equal(databases.get(root).files.size, 1);
});

test('startup preserves offline progress as an alternate and loads synced saves without a prompt', async () => {
  const server = new Map(), databases = new Map(), metadata = new Map();
  const a = browser(server, databases, { metadata }); await a.start(); await a.save('initial');
  a.offline(true); await a.save('offline progress');
  const b = browser(server, new Map()); await b.start(); await b.save('server progress');
  const reload = browser(server, databases, { metadata }); await reload.start();
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'server progress');
  assert.ok(reload.statuses.includes('Unsynced device saves preserved in history'));
  assert.equal(server.alternates.length, 1);
  const copy = server.alternates[0].snapshot;
  assert.equal(Buffer.from(copy.files[0].data, 'base64').toString(), 'offline progress');
});

test('unchanged filesystem flushes and timestamp-only touches do not upload or flash status', async () => {
  const server = new Map(); const a = browser(server, new Map());
  await a.start(); await a.save('saved progress');
  const notices = [...a.statuses];
  for (let i = 0; i < 30; i++) await a.flush();
  await a.retry();
  assert.equal(server.get('A:X').revision, 1);
  assert.deepEqual(a.statuses, notices);
  a.fs.utime(`${root}/game/1.save`, 9999, 9999);
  await a.flush(); await a.retry();
  assert.equal(server.get('A:X').revision, 1);
  assert.deepEqual(a.statuses, notices);
});

test('frequent real changes are batched and persistent-only changes and deletions still sync', async () => {
  const server = new Map(); const a = browser(server, new Map()); await a.start(); await a.save();
  for (let i = 0; i < 30; i++) {
    a.fs.writeFile(`${root}/game/persistent`, Buffer.from(`seen text ${i}`));
    await a.flush();
  }
  assert.equal(server.get('A:X').revision, 1);
  await a.retry();
  assert.equal(server.get('A:X').revision, 2);
  const persistent = server.get('A:X').snapshot.files.find(f => f.path.endsWith('/persistent'));
  assert.equal(Buffer.from(persistent.data, 'base64').toString(), 'seen text 29');
  a.fs.unlink(`${root}/game/1.save`); await a.flush(); await a.retry();
  assert.equal(server.get('A:X').revision, 3);
  assert.equal(server.get('A:X').snapshot.files.length, 1);
  assert.equal(a.events.filter(event => event.saveUploaded).length, 1);
});

test('each successful save-slot upload is acknowledged; offline failures are not', async () => {
  const server = new Map(); const a = browser(server, new Map()); await a.start();
  await a.save('first'); await a.save('second');
  assert.equal(a.events.filter(event => event.saveUploaded).length, 2);
  a.offline(true); await a.save('offline save');
  assert.equal(a.events.filter(event => event.saveUploaded).length, 2);
  a.offline(false); await a.retry();
  assert.equal(a.events.filter(event => event.saveUploaded).length, 3);
  for (const filename of ['auto-1.save', 'quick-1.save']) {
    a.fs.writeFile(`${root}/game/${filename}`, Buffer.from(filename));
    await a.flush(); await a.retry();
  }
  assert.equal(a.events.filter(event => event.saveUploaded).length, 5);
});

test('direct and atomic slot writes upload after flush without waiting for the timer', async () => {
  const server = new Map(); const a = browser(server, new Map()); await a.start();
  a.fs.mkdirTree(`${root}/game`);
  a.fs.writeFile(`${root}/game/1.save`, Buffer.from('first'));
  assert.equal(server.has('A:X'), false);
  await a.flush();
  assert.equal(server.get('A:X').revision, 1);
  a.fs.writeFile(`${root}/game/1.save`, Buffer.from('first')); await a.flush();
  assert.equal(server.get('A:X').revision, 1, 'identical slot bytes are deduplicated');
  a.fs.writeFile(`${root}/game/persistent`, Buffer.from('preferences')); await a.flush();
  assert.equal(server.get('A:X').revision, 1, 'persistent data stays batched');
  a.fs.writeFile(`${root}/game/tmp`, Buffer.from('quick save'));
  a.fs.rename(`${root}/game/tmp`, `${root}/game/quick-1.save`);
  await a.flush();
  assert.equal(server.get('A:X').revision, 2);
  assert.equal(a.events.filter(event => event.saveUploaded).length, 2);
});

test('completed slot writes persist and upload without an engine flush or retry timer', async () => {
  const server = new Map(), databases = new Map(); const a = browser(server, databases); await a.start();
  a.fs.mkdirTree(`${root}/game`);
  a.fs.writeFile(`${root}/game/1.save`, Buffer.from('manual save'));
  await new Promise(resolve => setTimeout(resolve, 20)); await settle();
  assert.equal(server.get('A:X').revision, 1);
  assert.ok(databases.get(a.namespace).files.has(`${root}/game/1.save`), 'Persist before acknowledging');
  a.fs.writeFile(`${root}/game/temp`, Buffer.from('quick save'));
  a.fs.rename(`${root}/game/temp`, `${root}/game/quick-1.save`);
  await new Promise(resolve => setTimeout(resolve, 20)); await settle();
  assert.equal(server.get('A:X').revision, 2);
  assert.equal(a.events.filter(event => event.saveUploaded).length, 2);
});

test('changed-file uploads omit untouched slots, include deletions, and fall back safely on a stale baseline', async () => {
  const server = new Map(), a = browser(server, new Map()); await a.start();
  a.fs.mkdirTree(`${root}/game`);
  a.fs.writeFile(`${root}/game/2.save`, Buffer.alloc(1024 * 1024, 42)); await a.save('first');
  await a.save('second');
  const patch = server.uploads.at(-1);
  assert.equal(patch.snapshot, undefined);
  assert.equal(patch.delta.files.length, 1);
  assert.equal(patch.delta.files[0].path, 'game/1.save');
  assert.ok(JSON.stringify(patch).length < 1024, 'Unchanged large slot does not cross the network');
  a.fs.unlink(`${root}/game/2.save`); await a.flush(); await a.retry();
  assert.deepEqual(server.uploads.at(-1).delta.deleted, ['game/2.save']);
  assert.equal(server.get('A:X').snapshot.files.length, 1);
  const other = browser(server, new Map()); await other.start(); await other.save('another device');
  await a.save('independent progress');
  const attempts = server.uploads.slice(-2);
  assert.ok(attempts[0].delta); assert.ok(attempts[1].snapshot);
  assert.equal(attempts[0].uploadId, attempts[1].uploadId);
  assert.equal(server.alternates.at(-1).snapshot.files[0].data, Buffer.from('independent progress').toString('base64'));
  assert.equal(server.get('A:X').snapshot.files[0].data, Buffer.from('another device').toString('base64'));
});

test('encoding cache skips unchanged bytes but detects same-size edits with unchanged timestamps', async () => {
  const server = new Map(), a = browser(server, new Map()); await a.start(); await a.save('abc');
  const count = a.encodedCount();
  a.fs.utime(`${root}/game/1.save`, 9999, 9999); await a.flush(); await a.retry();
  assert.equal(a.encodedCount(), count);
  a.fs.writeFile(`${root}/game/1.save`, Buffer.from('def'));
  a.fs.utime(`${root}/game/1.save`, 9999, 9999); await a.flush();
  assert.equal(a.encodedCount(), count + 1);
  assert.equal(Buffer.from(server.get('A:X').snapshot.files[0].data, 'base64').toString(), 'def');
});

test('servers without delta capability keep receiving complete snapshots', async () => {
  const server = new Map(); server.deltaUploads = false;
  const a = browser(server, new Map()); await a.start(); await a.save('first'); await a.save('second');
  assert.ok(server.uploads.every(upload => upload.snapshot && !upload.delta));
});

test('lost full-fallback acknowledgement survives reload without duplicating an alternate', async () => {
  const server = new Map(), databases = new Map(), metadata = new Map();
  const a = browser(server, databases, { metadata }); await a.start(); await a.save('baseline');
  const other = browser(server, new Map()); await other.start(); await other.save('server progress');
  a.loseNextResponse();
  a.fs.writeFile(`${root}/game/1.save`, Buffer.from('independent progress')); await a.flush();
  assert.equal(server.alternates.length, 1);
  const stored = databases.get('vnm-save-outbox').files.get('uploads:vnm-saves:A:X');
  assert.equal(stored.delta, undefined, 'Fallback mode is durable before sending');
  assert.ok(stored.snapshot);
  const reload = browser(server, databases, { metadata }); await reload.start();
  assert.equal(server.alternates.length, 1);
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'server progress');
});

test('a slot saved during an upload follows immediately after its acknowledgement', async () => {
  const server = new Map(); const a = browser(server, new Map()); await a.start();
  const release = a.pauseNextUpload();
  a.fs.mkdirTree(`${root}/game`);
  a.fs.writeFile(`${root}/game/auto-1.save`, Buffer.from('first')); await a.flush();
  a.fs.writeFile(`${root}/game/auto-1.save`, Buffer.from('second')); await a.flush();
  assert.equal(server.get('A:X').revision, 1);
  release(); await settle();
  assert.equal(server.get('A:X').revision, 2);
  const slot = server.get('A:X').snapshot.files.find(file => file.path.endsWith('auto-1.save'));
  assert.equal(Buffer.from(slot.data, 'base64').toString(), 'second');
});

test('lost acknowledgement retries the same upload before uploading newer offline progress', async () => {
  const server = new Map(), databases = new Map(), metadata = new Map();
  const a = browser(server, databases, { metadata }); await a.start();
  a.loseNextResponse();
  a.fs.mkdirTree(`${root}/game`);
  a.fs.writeFile(`${root}/game/1.save`, Buffer.from('committed')); await a.flush();
  assert.equal(server.get('A:X').revision, 1);
  const firstId = server.get('A:X').uploadId;
  a.offline(true); a.fs.writeFile(`${root}/game/1.save`, Buffer.from('offline progress')); await a.flush();
  const reload = browser(server, databases, { metadata }); reload.offline(true); await reload.start();
  reload.offline(false); await reload.retry();
  assert.equal(server.get('A:X').revision, 2);
  assert.notEqual(server.get('A:X').uploadId, firstId);
  assert.equal(Buffer.from(server.get('A:X').snapshot.files.find(file => file.path.endsWith('.save')).data, 'base64').toString(), 'offline progress');
  assert.ok(!reload.statuses.some(status => status.startsWith('Conflict')));
});

test('reload recognizes an already committed upload even when its response was lost', async () => {
  const server = new Map(), databases = new Map(), metadata = new Map();
  const a = browser(server, databases, { metadata }); await a.start();
  a.loseNextResponse(); a.fs.mkdirTree(`${root}/game`);
  a.fs.writeFile(`${root}/game/1.save`, Buffer.from('committed')); await a.flush();
  const reload = browser(server, databases, { metadata }); await reload.start();
  assert.equal(server.get('A:X').revision, 1);
  assert.ok(!reload.statuses.some(status => status.startsWith('Conflict')));
  assert.ok(!databases.get('vnm-save-outbox').files.has('uploads:vnm-saves:A:X'));
});

test('page and visibility restoration restart one timer and upload pending offline data', async () => {
  const server = new Map(); const a = browser(server, new Map()); await a.start();
  a.offline(true); a.fs.mkdirTree(`${root}/game`);
  a.fs.writeFile(`${root}/game/persistent`, Buffer.from('preferences')); await a.flush();
  await a.event('pagehide'); assert.equal(a.activeTimers(), 0);
  a.offline(false); await a.event('pageshow');
  assert.equal(a.activeTimers(), 1); assert.equal(server.get('A:X').revision, 1);
  await a.event('pageshow'); await a.visibility('visible');
  assert.equal(a.activeTimers(), 1);
  assert.equal(server.get('A:X').revision, 1);
});

test('desktop-to-mobile handoff silently replaces stale slots despite dirty persistent data', async () => {
  const server = new Map(), mobileDatabases = new Map(), mobileMetadata = new Map();
  const desktop = browser(server, new Map()); await desktop.start(); await desktop.save('first');
  const mobile = browser(server, mobileDatabases, { metadata: mobileMetadata }); await mobile.start();
  mobile.offline(true);
  mobile.fs.writeFile(`${root}/game/persistent`, Buffer.from('local seen text')); await mobile.flush();
  await desktop.save('new desktop progress');
  const reload = browser(server, mobileDatabases, { metadata: mobileMetadata }); await reload.start();
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'new desktop progress');
  assert.equal(server.get('A:X').revision, 2);
  assert.ok(!reload.statuses.some(status => status.startsWith('Conflict')));
});

test('actual offline slot progress on both devices is archived before loading the server continuation', async () => {
  const server = new Map(), mobileDatabases = new Map(), mobileMetadata = new Map();
  const desktop = browser(server, new Map()); await desktop.start(); await desktop.save('first');
  const mobile = browser(server, mobileDatabases, { metadata: mobileMetadata }); await mobile.start();
  mobile.offline(true); await mobile.save('offline mobile progress');
  await desktop.save('desktop progress');
  const reload = browser(server, mobileDatabases, { metadata: mobileMetadata }); await reload.start();
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'desktop progress');
  assert.ok(reload.statuses.includes('Unsynced device saves preserved in history'));
  assert.equal(Buffer.from(server.alternates[0].snapshot.files.find(file => file.path.endsWith('.save')).data, 'base64').toString(), 'offline mobile progress');
});

test('offline save progress publishes without conflict when only server preferences advanced', async () => {
  const server = new Map(), mobileDatabases = new Map(), mobileMetadata = new Map();
  const desktop = browser(server, new Map()); await desktop.start(); await desktop.save('first');
  const mobile = browser(server, mobileDatabases, { metadata: mobileMetadata }); await mobile.start();
  mobile.offline(true); await mobile.save('offline mobile progress');
  desktop.fs.writeFile(`${root}/game/persistent`, Buffer.from('desktop preferences'));
  await desktop.flush(); await desktop.retry();
  assert.equal(server.get('A:X').revision, 2);
  const reload = browser(server, mobileDatabases, { metadata: mobileMetadata }); await reload.start();
  assert.equal(server.get('A:X').revision, 3);
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'offline mobile progress');
  assert.ok(!reload.statuses.some(status => status.startsWith('Conflict')));
});

test('a lost acknowledgement remains valid after another device advances the server', async () => {
  const server = new Map(), databases = new Map(), metadata = new Map();
  const desktop = browser(server, databases, { metadata }); await desktop.start(); await desktop.save('first');
  desktop.loseNextResponse(); desktop.fs.writeFile(`${root}/game/1.save`, Buffer.from('accepted desktop save')); await desktop.flush();
  const mobile = browser(server, new Map()); await mobile.start(); await mobile.save('new mobile save');
  const reload = browser(server, databases, { metadata }); await reload.start();
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'new mobile save');
  assert.equal(server.alternates.length, 0);
  assert.equal(server.get('A:X').revision, 3);
});

test('an evicted clean browser filesystem restores the server copy instead of publishing deletions', async () => {
  const server = new Map(), databases = new Map(), metadata = new Map();
  const a = browser(server, databases, { metadata }); await a.start(); await a.save('server progress');
  databases.get(a.namespace).files.clear();
  const reload = browser(server, databases, { metadata }); await reload.start();
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'server progress');
  assert.equal(server.get('A:X').revision, 1);
});
