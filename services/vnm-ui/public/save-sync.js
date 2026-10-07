/* Ren'Py 8.5 IDBFS bridge. Loaded before renpy-pre.js by the serving layer. */
(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  const gameId = params.get('vnmGame');
  const userId = params.get('vnmUser');
  const token = localStorage.getItem('vnm-token');
  if (!gameId || !userId || !token || window.parent === window) return;
  try {
    const claim = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (claim.userId !== userId) return;
  } catch { return; }
  const root = '/home/web_user/.renpy';
  const namespace = `vnm-saves:${encodeURIComponent(userId)}:${encodeURIComponent(gameId)}`;
  const metaKey = `${namespace}:meta`;
  let meta;
  try { meta = JSON.parse(localStorage.getItem(metaKey)) || { revision: 0, dirty: false }; }
  catch { meta = { revision: 0, dirty: true }; }
  let initialized = false, blocked = false, busy = false, timer;
  let lastUploadedContents = null, lastStatus;
  let lastUploadedSlots = new Map();
  let fs, nativeSync, originalGetDB;
  const status = (message, saveUploaded = false) => {
    if (message === lastStatus && !saveUploaded) return;
    lastStatus = message;
    parent.postMessage({ type: 'vnm-save-status', message, saveUploaded }, location.origin);
  };
  const slots = copy => new Map(copy.files.filter(file => file.path.endsWith('.save'))
    .map(file => [file.path, file.data]));
  // Ren'Py may flush repeatedly or touch mtimes without changing save bytes.
  // Exact comparisons avoid hash collisions and work on HTTP LAN deployments.
  const contents = copy => JSON.stringify(copy.files.map(({ path, data }) => ({ path, data }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const remember = () => localStorage.setItem(metaKey, JSON.stringify(meta));
  const api = async (method, body) => {
    // Never upload an old session's filesystem using a newly logged-in account.
    if (localStorage.getItem('vnm-token') !== token) throw new Error('Account changed');
    const response = await fetch(`/api/v1/games/${encodeURIComponent(gameId)}/saves`, {
      method, cache: 'no-store', signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 409) { blocked = true; throw new Error('Conflict detected — browser saves preserved. Reload to choose a copy.'); }
    if (!response.ok) throw new Error(`Save service unavailable (${response.status})`);
    return response.json();
  };
  function snapshot() {
    const files = [];
    function walk(directory) {
      for (const name of fs.readdir(directory).filter(n => n !== '.' && n !== '..').sort()) {
        const path = `${directory}/${name}`;
        const stat = fs.stat(path);
        if (fs.isDir(stat.mode)) walk(path);
        else if (fs.isFile(stat.mode)) {
          const bytes = fs.readFile(path);
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          files.push({ path: path.slice(root.length + 1), mtime: stat.mtime.getTime(), data: btoa(binary) });
        }
      }
    }
    walk(root);
    return { version: 1, files };
  }
  function restore(copy) {
    // Validate completely before touching the filesystem, even for server data.
    const seen = new Set();
    let total = 0;
    if (copy?.version !== 1 || !Array.isArray(copy.files) || copy.files.length > 4096) throw new Error('Unsupported snapshot');
    const decoded = copy.files.map(file => {
      if (!file.path || file.path.length > 512 || /[\\\x00-\x1f]/.test(file.path) ||
          file.path.split('/').some(p => !p || p === '.' || p === '..') || seen.has(file.path) ||
          !Number.isSafeInteger(file.mtime) || file.mtime < 0 || file.mtime > 8640000000000000) throw new Error('Invalid snapshot path');
      seen.add(file.path);
      const bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
      total += bytes.length;
      if (total > 32 * 1024 * 1024) throw new Error('Snapshot too large');
      return { ...file, bytes };
    });
    for (const path of seen) {
      const parts = path.split('/');
      while (parts.length > 1) { parts.pop(); if (seen.has(parts.join('/'))) throw new Error('Invalid snapshot tree'); }
    }
    function clear(path) {
      for (const name of fs.readdir(path).filter(n => n !== '.' && n !== '..')) {
        const child = `${path}/${name}`;
        if (fs.isDir(fs.stat(child).mode)) { clear(child); fs.rmdir(child); }
        else fs.unlink(child);
      }
    }
    clear(root);
    for (const file of decoded) {
      const path = `${root}/${file.path}`;
      fs.mkdirTree(path.slice(0, path.lastIndexOf('/')));
      fs.writeFile(path, file.bytes);
      fs.utime(path, file.mtime, file.mtime);
    }
  }
  const flush = () => new Promise((resolve, reject) => nativeSync(false, err => err ? reject(err) : resolve()));
  function backup(copy) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('vnm-save-backups', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('snapshots');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('snapshots', 'readwrite');
        tx.objectStore('snapshots').put(copy, `${namespace}:${Date.now()}`);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }
  // Choices are explicit; never guess which game's legacy directory belongs here.
  function choose(message, options) {
    return new Promise(resolve => {
      const panel = document.createElement('div');
      panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#111e;color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;font:16px sans-serif';
      const text = document.createElement('p'); text.textContent = message; panel.append(text);
      for (const [label, value] of options) {
        const button = document.createElement('button'); button.textContent = label;
        button.style.cssText = 'padding:12px;background:#334155;color:white;border:1px solid #94a3b8;border-radius:6px;cursor:pointer';
        button.onclick = () => { panel.remove(); resolve(value); }; panel.append(button);
      }
      document.body.append(panel);
    });
  }
  async function legacyCopy() {
    const db = await new Promise((resolve, reject) => originalGetDB(root, (err, db) => err ? reject(err) : resolve(db)));
    const entries = await new Promise((resolve, reject) => {
      const tx = db.transaction('FILE_DATA', 'readonly');
      const list = []; const req = tx.objectStore('FILE_DATA').openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { list.push([c.key, c.value]); c.continue(); } };
      tx.oncomplete = () => resolve(list); tx.onabort = () => reject(tx.error);
    });
    const folders = [...new Set(entries.filter(([path, entry]) => path.startsWith(`${root}/`) && entry.contents)
      .map(([path]) => path.slice(root.length + 1).split('/')[0]))].filter(n => n !== 'tokens');
    if (!folders.length) return null;
    const folder = await choose('Existing browser saves found. Select this game’s save folder to import a copy. The original stays untouched.',
      [['Start without importing', null], ...folders.map(n => [`Import ${n}`, n])]);
    if (!folder) return null;
    return { version: 1, files: entries.filter(([path, entry]) => entry.contents &&
      (path.startsWith(`${root}/${folder}/`) || path.startsWith(`${root}/tokens/`))).map(([path, entry]) => {
        const bytes = new Uint8Array(entry.contents); let data = '';
        for (let i = 0; i < bytes.length; i += 8192) data += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return { path: path.slice(root.length + 1), mtime: new Date(entry.timestamp).getTime(), data: btoa(data) };
      }) };
  }
  async function start() {
    const local = snapshot();
    if (!meta.dirty) {
      lastUploadedContents = contents(local);
      lastUploadedSlots = slots(local);
    }
    try {
      const remote = await api('GET');
      lastUploadedContents = contents(remote.snapshot || { files: [] });
      lastUploadedSlots = slots(remote.snapshot || { files: [] });
      if (remote.snapshot && local.files.length && (meta.dirty || meta.revision === 0)) {
        if (remote.revision !== meta.revision || meta.revision === 0) {
          const choice = await choose('Save conflict: this browser and server both have progress.', [
            ['Continue with browser copy (sync paused)', 'local'],
            ['Use server copy (back up browser copy first)', 'server'],
          ]);
          if (choice === 'local') { blocked = true; status('Conflict detected — browser saves only'); return; }
          await backup(local);
          restore(remote.snapshot); await flush();
          meta = { revision: remote.revision, dirty: false }; remember();
        }
      } else if (remote.snapshot) {
        if (local.files.length) await backup(local);
        restore(remote.snapshot); await flush();
        meta = { revision: remote.revision, dirty: false }; remember();
      } else if (!local.files.length) {
        const legacy = await legacyCopy();
        if (legacy) { restore(legacy); await flush(); meta.dirty = true; remember(); }
      }
      // Existing isolated browser saves with no server record are safely imported.
      if (!remote.snapshot && snapshot().files.length) { meta.revision = 0; meta.dirty = true; remember(); }
      if (!meta.dirty) status('Saves synced');
    } catch (error) {
      // Unknown server revision must never become permission to overwrite it later.
      // Restore failures also leave the previously loaded local files available.
      restore(local);
      status('Offline — browser saves only');
    }
  }
  async function upload() {
    if (!initialized || blocked || busy || !meta.dirty) return;
    busy = true;
    let syncingNotice;
    try {
      const copy = snapshot(); const copyContents = contents(copy);
      if (copyContents === lastUploadedContents) {
        meta.dirty = false; remember();
        return;
      }
      // Confirm actual Ren'Py slot uploads separately from persistent-only writes.
      // Only server-acknowledged additions/changes qualify; deletions do not.
      const saveUploaded = copy.files.some(file => file.path.endsWith('.save') &&
        lastUploadedSlots.get(file.path) !== file.data);
      // Fast background uploads should not flash the status on each interaction.
      syncingNotice = setTimeout(() => status('Syncing…'), 500);
      const result = await api('PUT', { revision: meta.revision, snapshot: copy });
      clearTimeout(syncingNotice);
      lastUploadedContents = copyContents;
      lastUploadedSlots = slots(copy);
      meta.revision = result.revision;
      meta.dirty = contents(snapshot()) !== copyContents;
      remember(); status(meta.dirty ? 'Syncing…' : 'Saves synced', saveUploaded);
    } catch (error) { status(blocked ? error.message : 'Offline — browser saves only'); }
    finally { clearTimeout(syncingNotice); busy = false; }
  }
  window.Module = window.Module || {};
  const oldPreInit = Module.preInit;
  Module.preInit = [...(Array.isArray(oldPreInit) ? oldPreInit : oldPreInit ? [oldPreInit] : []), () => {
    fs = Module.FS || window.FS;
    if (!fs || !window.IDBFS?.getDB) { status('Unsupported runtime — browser saves only'); return; }
    originalGetDB = IDBFS.getDB.bind(IDBFS);
    IDBFS.getDB = (name, callback) => originalGetDB(name === root ? namespace : name, callback);
    nativeSync = fs.syncfs.bind(fs);
    fs.syncfs = (populate, callback = () => {}) => {
      if (!populate && initialized) {
        meta.dirty = true;
        try { remember(); } catch { blocked = true; status('Browser storage full — sync paused'); }
      }
      nativeSync(populate, err => {
        if (err) { status('Browser save storage failed'); callback(err); return; }
        if (populate && !initialized) {
          start().finally(() => {
            initialized = true; callback(null);
            timer = setInterval(upload, 5000); upload();
          });
        } else {
          // Keep browser writes immediate; coalesce server uploads on the five
          // second interval instead of uploading on every filesystem flush.
          callback(null);
        }
      });
    };
  }];
  window.addEventListener('online', upload);
  window.addEventListener('pagehide', () => { clearInterval(timer); });
})();
