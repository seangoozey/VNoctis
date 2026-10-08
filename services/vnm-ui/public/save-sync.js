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
  let slotWritePending = false, urgentUploadPending = false;
  let pendingUpload = null;
  let acknowledgedSlots = null;
  let fs, nativeSync, originalGetDB;
  const status = (message, saveUploaded = false) => {
    if (message === lastStatus && !saveUploaded) return;
    lastStatus = message;
    parent.postMessage({ type: 'vnm-save-status', message, saveUploaded }, location.origin);
  };
  const slots = copy => new Map(copy.files.filter(file => file.path.endsWith('.save'))
    .map(file => [file.path, file.data]));
  const slotContents = copy => JSON.stringify([...slots(copy)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  async function checkpoint(copy, revision, saveChecksum = null) {
    const next = { revision, contents: slotContents(copy), saveChecksum };
    await outbox('put', next, 'baselines'); acknowledgedSlots = next;
  }
  // Ren'Py may flush repeatedly or touch mtimes without changing save bytes.
  // Exact comparisons avoid hash collisions and work on HTTP LAN deployments.
  const contents = copy => JSON.stringify(copy.files.map(({ path, data }) => ({ path, data }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const remember = () => localStorage.setItem(metaKey, JSON.stringify(meta));
  const deviceLabel = /Mobi|Android|iPad/i.test(window.navigator?.userAgent || '') ? 'Mobile browser' : 'Desktop browser';
  const requestFor = copy => ({ uploadId: window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`,
    revision: meta.revision, snapshot: copy, baseSaveChecksum: meta.baseSaveChecksum || null,
    alternate: Boolean(meta.alternate), branchId: meta.branchId || null, deviceLabel });
  const api = async (method, body, query = '') => {
    // Never upload an old session's filesystem using a newly logged-in account.
    if (localStorage.getItem('vnm-token') !== token) throw new Error('Account changed');
    const response = await fetch(`/api/v1/games/${encodeURIComponent(gameId)}/saves${query}`, {
      method, cache: 'no-store', signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 409) { blocked = true; throw new Error('Save upload could not be verified — device saves retained'); }
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
  // Keep the exact request across network failures and reloads. Storing its
  // potentially large snapshot in IndexedDB avoids localStorage's small quota.
  function outbox(operation, value, storeName = 'uploads') {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('vnm-save-outbox', 2);
      req.onupgradeneeded = () => {
        for (const name of ['uploads', 'baselines']) {
          if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
        }
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(storeName, operation === 'get' ? 'readonly' : 'readwrite');
        const store = tx.objectStore(storeName);
        const action = operation === 'put' ? store.put(value, namespace) : store[operation](namespace);
        tx.oncomplete = () => { db.close(); resolve(action.result); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }
  // Choices are explicit; never guess which game's legacy directory belongs here.
  function choose(message, options) {
    return new Promise(resolve => {
      const panel = document.createElement('div');
      panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#111e;color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;font:16px sans-serif';
      const text = document.createElement('p'); text.textContent = message;
      text.style.cssText = 'width:100%;max-width:480px;line-height:1.5'; panel.append(text);
      for (const [label, value, description] of options) {
        const button = document.createElement('button'); button.textContent = label;
        button.style.cssText = `width:100%;max-width:480px;padding:16px;text-align:left;background:${value === 'server' ? '#047857' : '#334155'};color:white;border:1px solid #94a3b8;border-radius:6px;cursor:pointer;font:inherit`;
        if (description) {
          const detail = document.createElement('span'); detail.textContent = description;
          detail.style.cssText = 'display:block;margin-top:6px;font-size:14px;line-height:1.5;opacity:.85';
          button.append(detail);
        }
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
    let local = snapshot();
    if (!meta.dirty) {
      lastUploadedContents = contents(local);
      lastUploadedSlots = slots(local);
    }
    try {
      pendingUpload = await outbox('get') || null;
      acknowledgedSlots = await outbox('get', undefined, 'baselines') || null;
      if (pendingUpload) { meta.revision = pendingUpload.revision; meta.dirty = true; }
      else if (acknowledgedSlots && acknowledgedSlots.revision > meta.revision) meta.revision = acknowledgedSlots.revision;
      let remote = await api('GET', null, pendingUpload ? `?uploadId=${encodeURIComponent(pendingUpload.uploadId)}` : '');
      let preserved = false;
      // Receipts outlive history pruning and later writes by other devices.
      if (pendingUpload) {
        if (!local.files.length && pendingUpload.snapshot.files.length) {
          local = pendingUpload.snapshot; restore(local); await flush();
        }
        const result = remote.acknowledgement || await api('PUT', pendingUpload);
        preserved = result.disposition === 'alternate';
        await acknowledge(pendingUpload.snapshot, result);
        remote = await api('GET');
      }
      if (!remote.snapshot && !local.files.length) {
        const legacy = await legacyCopy();
        if (legacy) { local = legacy; restore(local); await flush(); meta.dirty = true; remember(); }
      }
      const knownBaseline = acknowledgedSlots?.revision === meta.revision;
      const slotChanges = knownBaseline ? meta.dirty && acknowledgedSlots.contents !== slotContents(local)
        : (meta.dirty || meta.revision === 0) && local.files.length > 0;
      const slotsAgree = remote.snapshot && slotContents(local) === slotContents(remote.snapshot);
      const needsUpload = !remote.snapshot ? local.files.length > 0 : !slotsAgree &&
        (slotChanges || (meta.alternate && meta.dirty));
      if (needsUpload) {
        // Publish one-sided offline progress, or preserve it as an alternate if
        // another device also advanced. Neither case needs a blocking choice.
        if (knownBaseline && acknowledgedSlots.contents === slotContents(remote.snapshot || { files: [] })) {
          meta.baseSaveChecksum = remote.saveChecksum;
        }
        const next = requestFor(local);
        await outbox('put', next); pendingUpload = next;
        const result = await api('PUT', next);
        preserved ||= result.disposition === 'alternate';
        await acknowledge(local, result);
        remote = await api('GET');
      }
      if (remote.snapshot) {
        restore(remote.snapshot); await flush();
        await checkpoint(remote.snapshot, remote.revision, remote.saveChecksum);
        meta = { revision: remote.revision, dirty: false, baseSaveChecksum: remote.saveChecksum, alternate: false }; remember();
        lastUploadedContents = contents(remote.snapshot); lastUploadedSlots = slots(remote.snapshot);
      } else {
        await checkpoint({ version: 1, files: [] }, 0, remote.saveChecksum);
        meta.revision = 0; meta.baseSaveChecksum = remote.saveChecksum; remember();
      }
      status(preserved ? 'Unsynced device saves preserved in history' : 'Saves synced');
    } catch (error) {
      // Unknown server revision must never become permission to overwrite it later.
      // Restore failures also leave the previously loaded local files available.
      restore(local);
      status('Offline — browser saves only');
    }
  }
  async function acknowledge(copy, result) {
    const alternate = result.disposition === 'alternate';
    const base = alternate ? meta.baseSaveChecksum || null : result.saveChecksum;
    await checkpoint(copy, result.revision, base);
    await outbox('delete'); pendingUpload = null;
    meta.revision = result.revision; meta.baseSaveChecksum = base; meta.alternate = alternate;
    meta.branchId = alternate ? result.branchId : null;
    meta.dirty = contents(snapshot()) !== contents(copy); remember();
    lastUploadedContents = contents(copy); lastUploadedSlots = slots(copy);
  }
  async function upload() {
    if (!initialized || blocked || busy || !meta.dirty) return;
    busy = true;
    let syncingNotice;
    try {
      const copy = pendingUpload?.snapshot || snapshot(); const copyContents = contents(copy);
      if (!pendingUpload && copyContents === lastUploadedContents) {
        meta.dirty = false; remember();
        return;
      }
      // Confirm actual Ren'Py slot uploads separately from persistent-only writes.
      // Only server-acknowledged additions/changes qualify; deletions do not.
      const saveUploaded = copy.files.some(file => file.path.endsWith('.save') &&
        lastUploadedSlots.get(file.path) !== file.data);
      if (!pendingUpload) {
        // Alternate continuations retain real save changes, without archiving
        // every seen-text/preference flush as another unresolved alternative.
        if (meta.alternate && slotContents(copy) === acknowledgedSlots?.contents) {
          meta.dirty = false; remember(); return;
        }
        const next = requestFor(copy);
        await outbox('put', next); pendingUpload = next;
      }
      // Fast background uploads should not flash the status on each interaction.
      syncingNotice = setTimeout(() => status('Syncing…'), 500);
      const result = await api('PUT', pendingUpload);
      clearTimeout(syncingNotice);
      await acknowledge(copy, result);
      const current = snapshot();
      meta.dirty = contents(current) !== copyContents;
      if (current.files.some(file => file.path.endsWith('.save') && lastUploadedSlots.get(file.path) !== file.data)) {
        urgentUploadPending = true;
      }
      remember(); status(result.disposition === 'alternate' ? 'Save backed up as alternate version'
        : meta.dirty ? 'Syncing…' : 'Saves synced', saveUploaded);
    } catch (error) { status(blocked ? error.message : 'Offline — browser saves only'); }
    finally {
      clearTimeout(syncingNotice); busy = false;
      if (urgentUploadPending) { urgentUploadPending = false; upload(); }
    }
  }
  window.Module = window.Module || {};
  const oldPreInit = Module.preInit;
  Module.preInit = [...(Array.isArray(oldPreInit) ? oldPreInit : oldPreInit ? [oldPreInit] : []), () => {
    fs = Module.FS || window.FS;
    if (!fs || !window.IDBFS?.getDB) { status('Unsupported runtime — browser saves only'); return; }
    originalGetDB = IDBFS.getDB.bind(IDBFS);
    IDBFS.getDB = (name, callback) => originalGetDB(name === root ? namespace : name, callback);
    nativeSync = fs.syncfs.bind(fs);
    let slotFlushTimer, flushes = 0;
    const scheduleSlotFlush = () => {
      slotWritePending = true;
      if (slotFlushTimer !== undefined) return;
      // Let the engine finish its synchronous writes/renames, then persist the
      // completed slot ourselves instead of waiting for its periodic syncfs.
      slotFlushTimer = setTimeout(() => {
        slotFlushTimer = undefined;
        if (slotWritePending && !flushes) fs.syncfs(false);
      }, 0);
    };
    const isSaveSlot = path => typeof path === 'string' && path.startsWith(`${root}/`) && path.endsWith('.save');
    // Ren'Py writes slots directly or renames a temporary file into place.
    // Watch these operations without scanning/encoding the tree on every frame.
    const nativeClose = fs.close.bind(fs);
    fs.close = stream => {
      const wroteSlot = initialized && (stream.flags & 3) !== 0 && isSaveSlot(stream.path);
      const result = nativeClose(stream);
      if (wroteSlot) scheduleSlotFlush();
      return result;
    };
    const nativeRename = fs.rename.bind(fs);
    fs.rename = (from, to) => {
      const result = nativeRename(from, to);
      if (initialized && isSaveSlot(to)) scheduleSlotFlush();
      return result;
    };
    fs.syncfs = (populate, callback = () => {}) => {
      if (!populate && initialized) {
        meta.dirty = true;
        try { remember(); } catch { blocked = true; status('Browser storage full — sync paused'); }
      }
      flushes++;
      nativeSync(populate, err => {
        flushes--;
        if (err) { status('Browser save storage failed'); callback(err); return; }
        if (populate && !initialized) {
          start().finally(() => {
            initialized = true; callback(null);
            resume();
          });
        } else {
          // Start slot uploads only after their browser storage flush succeeds.
          // Persistent-only writes retain the five-second batching interval.
          const urgent = !populate && slotWritePending;
          if (urgent) slotWritePending = false;
          callback(null);
          if (urgent) {
            if (busy) urgentUploadPending = true;
            else upload();
          }
        }
      });
    };
  }];
  function resume() {
    if (!initialized) return;
    clearInterval(timer); timer = setInterval(upload, 5000); upload();
  }
  window.addEventListener('online', upload);
  window.addEventListener('pagehide', () => { clearInterval(timer); timer = undefined; upload(); });
  window.addEventListener('pageshow', resume);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
    else upload();
  });
})();
