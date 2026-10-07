import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/save-sync.js', import.meta.url), 'utf8');
const root = '/home/web_user/.renpy';
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

// Model the IDBFS populate/flush boundary rather than Ren'Py save semantics.
function browser(server, databases, { user = 'A', game = 'X', metadata = new Map(), choices = [] } = {}) {
  const files = new Map(); const dirs = new Set([root]); const statuses = [];
  const events = [];
  const backups = new Map();
  let interval, offline = false;
  const token = `header.${Buffer.from(JSON.stringify({ userId: user })).toString('base64url')}.signature`;
  metadata.set('vnm-token', token);
  const namespace = `vnm-saves:${user}:${game}`;
  const fs = {
    readdir: path => ['.', '..', ...new Set([...dirs, ...files.keys()].filter(p => p.startsWith(`${path}/`)).map(p => p.slice(path.length + 1).split('/')[0]))],
    stat: path => ({ mode: dirs.has(path) ? 0o40777 : 0o100666, mtime: new Date(files.get(path)?.mtime || 0) }),
    isDir: mode => (mode & 0o170000) === 0o40000,
    isFile: mode => (mode & 0o170000) === 0o100000,
    readFile: path => files.get(path).bytes,
    writeFile: (path, bytes) => files.set(path, { bytes: new Uint8Array(bytes), mtime: 1234 }),
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
    atob: s => Buffer.from(s, 'base64').toString('binary'), btoa: s => Buffer.from(s, 'binary').toString('base64'),
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
    setInterval: callback => { interval = callback; return 1; }, clearInterval() {},
    addEventListener() {},
    document: { createElement: tag => ({ style: {}, append() {}, remove() {}, tag }), body: {
      append: panel => { /* replaced below to capture actual buttons */ },
    } },
    indexedDB: { open: () => {
      const req = {};
      queueMicrotask(() => {
        req.result = { close() {}, transaction: () => {
          const tx = { objectStore: () => ({ put: (copy, key) => {
            backups.set(key, JSON.parse(JSON.stringify(copy)));
            queueMicrotask(() => tx.oncomplete());
          } }) }; return tx;
        } }; req.onsuccess();
      }); return req;
    } },
    fetch: async (url, options) => {
      if (offline) throw new Error('network down');
      const key = `${user}:${game}`;
      const state = server.get(key) || { revision: 0, snapshot: null };
      if (options.method === 'GET') return { ok: true, status: 200, json: async () => state };
      const body = JSON.parse(options.body);
      if (state.revision !== body.revision) return { ok: false, status: 409 };
      const next = { revision: state.revision + 1, snapshot: body.snapshot };
      server.set(key, next); return { ok: true, status: 200, json: async () => next };
    },
  };
  const buttons = [];
  context.document.createElement = tag => ({ style: {}, append(child) { if (child.tag === 'button') buttons.push(child); }, remove() {}, tag });
  context.document.body.append = () => { const index = choices.shift() ?? 0; queueMicrotask(() => buttons.splice(0)[index].onclick()); };
  context.window = context;
  vm.createContext(context); vm.runInContext(source, context);
  return {
    fs, statuses, events, metadata, namespace, backups,
    offline: value => { offline = value; },
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
  assert.ok(b.statuses.some(s => s.startsWith('Conflict detected')));
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

test('startup conflict keeps offline progress unless server restoration is explicitly selected', async () => {
  const server = new Map(), databases = new Map(), metadata = new Map();
  const a = browser(server, databases, { metadata }); await a.start(); await a.save('initial');
  a.offline(true); await a.save('offline progress');
  const b = browser(server, new Map()); await b.start(); await b.save('server progress');
  const reload = browser(server, databases, { metadata }); await reload.start();
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'offline progress');
  assert.ok(reload.statuses.includes('Conflict detected — browser saves only'));
  const useServer = browser(server, databases, { metadata, choices: [1] }); await useServer.start();
  assert.equal(Buffer.from(useServer.fs.readFile(`${root}/game/1.save`)).toString(), 'server progress');
  assert.equal(useServer.backups.size, 1);
  const copy = [...useServer.backups.values()][0];
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
