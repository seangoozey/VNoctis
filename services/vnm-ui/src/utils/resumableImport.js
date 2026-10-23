import { createImportHasher } from './importHash.js';

const base = '/api/v1/library/import-uploads';
const failure = (message, status = 0, code = 'UPLOAD_ERROR') => Object.assign(new Error(message), { status, code });
export function importIdentity() {
  const token = localStorage.getItem('vnm-token');
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const user = JSON.parse(atob(payload));
    if (typeof user.userId !== 'string' || !user.userId) throw new Error();
    return { userId: user.userId, token };
  } catch { throw failure('Sign in again, then reselect the same archive to resume its upload.', 401, 'AUTH_REQUIRED'); }
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function parseReply(text, status) {
  let data;
  try { data = JSON.parse(text); }
  catch { throw failure(`Unreadable upload acknowledgement (HTTP ${status}).`, status >= 400 ? status : 0, 'INVALID_ACKNOWLEDGEMENT'); }
  if (status < 200 || status >= 300) throw failure(data.message || `Upload failed (HTTP ${status}).`, status, data.code);
  return data;
}
export async function importRequest(path, options = {}) {
  const { body, signal, headers, onProgress, onSent, idleMs = 90000, method = 'GET' } = options;
  if (body instanceof Blob && method === 'PUT') {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); let last = Date.now(), stalled = false, finished = false;
      const timer = setInterval(() => { if (Date.now() - last >= idleMs) { stalled = true; xhr.abort(); } }, 1000);
      const cleanup = () => { clearInterval(timer); signal?.removeEventListener('abort', abort); };
      const done = (callback, value) => { if (finished) return; finished = true; cleanup(); callback(value); };
      const abort = () => { xhr.abort(); done(reject, signal?.reason || new DOMException('Upload paused', 'AbortError')); };
      xhr.upload.onprogress = event => { last = Date.now(); onProgress?.(Math.min(body.size, event.loaded)); };
      xhr.upload.onload = () => { last = Date.now(); onSent?.(); };
      xhr.onload = () => { try { done(resolve, parseReply(xhr.responseText, xhr.status)); } catch (error) { done(reject, error); } };
      xhr.onerror = () => done(reject, failure('The upload connection was interrupted. Confirmed bytes are retained.', 0, 'NETWORK_ERROR'));
      xhr.onabort = () => done(reject, signal?.aborted ? signal.reason : failure(stalled ? 'No upload progress or server acknowledgement for 90 seconds.' : 'The upload connection closed.', 0, stalled ? 'UPLOAD_STALLED' : 'NETWORK_ERROR'));
      xhr.ontimeout = () => done(reject, failure('The upload request timed out.', 0, 'REQUEST_TIMEOUT'));
      try {
      xhr.open(method, path);
      for (const [key, value] of Object.entries(headers || {})) xhr.setRequestHeader(key, value);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else xhr.send(body);
      } catch (error) { done(reject, error); }
    });
  }
  try {
    const response = await fetch(path, { ...options, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    return parseReply(await response.text(), response.status);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error.status !== undefined) throw error;
    throw failure(error.name === 'TimeoutError' ? 'The server did not acknowledge the request within 30 seconds.' : error.message, 0, error.name === 'TimeoutError' ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR');
  }
}
const defaultDelay = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
});
const transient = error => !error.status || error.status === 408 || error.status === 409 || error.status === 425 || error.status === 429 || error.status >= 500;

/** Small bounded pipeline: hashing and durable acknowledgements overlap transfer. */
export async function uploadGameArchive(file, {
  signal: outerSignal, onProgress = () => {}, onDiagnostic = () => {}, resumeId,
  identity = importIdentity, request = importRequest, hasherFactory = createImportHasher,
  storage = globalThis.localStorage, delay = defaultDelay, maxRetries = 5,
} = {}) {
  const controller = new AbortController();
  const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
  const owner = identity().userId, hasher = hasherFactory(signal), started = Date.now();
  const key = `vnm-import-upload-v2:${owner}:${encodeURIComponent(file.name)}:${file.size}`;
  const tasks = new Map(), received = new Map();
  let session, offset = 0, initialBytes = 0, chunkSize, windowBytes, maxInflight, lastConfirmedAt = null;
  function diagnostic(stage, error, details = {}) {
    const entry = { time: new Date().toISOString(), uploadId: session?.uploadId || resumeId || null, stage,
      name: error.name || 'Error', message: error.message, status: error.status || null, code: error.code || null, confirmedBytes: offset, ...details };
    console.warn('[VNoctis import upload]', JSON.stringify(entry)); onDiagnostic(entry);
  }
  function totalSent() {
    const ranges = [[0, offset], ...[...received.values()].map(row => [row.offset, row.offset + row.size]),
      ...[...tasks.values()].map(task => [task.from, task.from + (task.loaded || 0)])].sort((a,b) => a[0]-b[0]);
    let end = 0, total = 0;
    for (const [from, to] of ranges) { if (to > end) total += to - Math.max(from, end); end = Math.max(end, to); }
    return total;
  }
  function report(stage, extra = {}) {
    const sentBytes = totalSent(), elapsedMs = Date.now() - started;
    onProgress({ stage, uploadId: session?.uploadId || null, size: file.size, confirmedBytes: offset, sentBytes,
      elapsedMs, lastConfirmedAt, bytesPerSecond: Math.max(0, sentBytes - initialBytes) / Math.max(1, elapsedMs / 1000), ...extra });
  }
  async function call(path, options = {}) {
    signal.throwIfAborted(); const auth = identity();
    if (auth.userId !== owner) throw failure('The signed-in account changed. Reselect the archive after signing in.', 403, 'ACCOUNT_CHANGED');
    return request(path, { ...options, signal, headers: { ...options.headers, Authorization: `Bearer ${auth.token}` } });
  }
  async function retry(path, options, stage) {
    for (let attempt = 0; ; attempt++) {
      try { return await call(path, options); }
      catch (error) {
        if (signal.aborted) throw signal.reason;
        diagnostic(stage, error, { attempt: attempt + 1 });
        if (!transient(error) || attempt >= maxRetries) throw error;
        report('retrying', { message: error.message, attempt: attempt + 1 });
        await delay(Math.min(16000, 1000 * 2 ** attempt), signal);
      }
    }
  }
  function validate(state) {
    if (!state || typeof state.uploadId !== 'string' || state.name !== file.name || state.size !== file.size ||
        !Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset > file.size ||
        !Array.isArray(state.pendingChunks || [])) throw failure('Server upload name, size or offset does not match this archive.', 409, 'UPLOAD_IDENTITY_MISMATCH');
    return state;
  }
  function apply(state) {
    validate(state); offset = Math.max(offset, state.offset);
    for (const row of state.pendingChunks || []) {
      if (!Number.isSafeInteger(row.offset) || !Number.isSafeInteger(row.size) || row.offset < state.offset || row.size < 1 || row.offset + row.size > file.size) throw failure('Invalid confirmed chunk range.', 409, 'UPLOAD_IDENTITY_MISMATCH');
      if (row.offset >= offset) received.set(row.offset, row);
    }
    for (const [from, row] of received) if (from + row.size <= offset) received.delete(from);
    lastConfirmedAt = Date.now(); session = { ...state, offset };
  }
  function accepted(state) {
    if (!['queued', 'running', 'done'].includes(state.status)) return false;
    try { storage?.removeItem(key); } catch { /* Optional recovery hint. */ }
    report('accepted', { jobId: state.jobId }); return true;
  }
  function nextRange() {
    let from = offset;
    const occupied = [...received.values()].map(row => [row.offset, row.offset + row.size])
      .concat([...tasks.values()].map(task => [task.from, task.from + task.chunk.size])).sort((a,b) => a[0]-b[0]);
    for (const [a,b] of occupied) { if (a > from) return { from, end: Math.min(a, from + chunkSize, offset + windowBytes, file.size) }; from = Math.max(from,b); }
    return { from, end: Math.min(from + chunkSize, offset + windowBytes, file.size) };
  }
  function confirmed(state, task) {
    return state.offset >= task.from + task.chunk.size || (state.pendingChunks || []).some(row => row.offset === task.from && row.size === task.chunk.size && row.checksum === task.hash);
  }
  async function transfer(task) {
    for (let attempt = 0; ; attempt++) {
      try {
        const state = validate(await call(`${base}/${session.uploadId}/chunk?offset=${task.from}`, {
          method: 'PUT', body: task.chunk, headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': task.hash },
          onProgress: loaded => { task.loaded = loaded; report('uploading', { lastNetworkProgressAt: Date.now() }); },
          onSent: () => { task.loaded = task.chunk.size; report('uploading', { lastNetworkProgressAt: Date.now() }); },
        }));
        if (!confirmed(state, task)) throw failure('The server did not confirm this chunk.', 0, 'INVALID_ACKNOWLEDGEMENT');
        apply(state); return {};
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        diagnostic('chunk', error, { attempt: attempt + 1, offset: task.from, chunkBytes: task.chunk.size });
        if (error.status === 413 && task.chunk.size > 256 * 1024) return { smaller: Math.max(256 * 1024, Math.floor(task.chunk.size / 2)) };
        if (!transient(error) || ['UPLOAD_CHUNK_CONFLICT','UPLOAD_IDENTITY_MISMATCH','UPLOAD_NOT_ACTIVE'].includes(error.code) || attempt >= maxRetries) throw error;
        report('retrying', { message: error.message, attempt: attempt + 1 });
        await delay(Math.min(16000, 1000 * 2 ** attempt), signal);
        try {
          const state = validate(await call(`${base}/${session.uploadId}`)); apply(state);
          if (confirmed(state, task)) return {};
          if (state.status !== 'uploading') throw failure('This upload is no longer active. Start a new upload.', 410, 'UPLOAD_NOT_ACTIVE');
        } catch (statusError) {
          diagnostic('resume-status', statusError);
          if (!transient(statusError) || statusError.code === 'UPLOAD_IDENTITY_MISMATCH') throw statusError;
        }
      }
    }
  }
  try {
    if (!file.size || !/\.(zip|tar\.bz2|rar)$/i.test(file.name)) throw failure('Select a non-empty .zip, .tar.bz2 or .rar archive.', 400);
    report('connecting');
    let limits;
    try { limits = await retry(base + '/limits', {}, 'upload-limits'); }
    catch (error) { if (error.status === 404) throw failure('Update the API and UI together to enable pipelined imports.',404,'SERVER_UPDATE_REQUIRED'); throw error; }
    if (!Number.isSafeInteger(limits.maxBytes) || file.size > limits.maxBytes) throw failure('The selected archive exceeds the server import size limit.',400,'UPLOAD_TOO_LARGE');
    if (limits.protocol !== 2) throw failure('Update the API and UI together to enable pipelined imports.',409,'SERVER_UPDATE_REQUIRED');
    let cached;
    try { cached = resumeId || storage?.getItem(key); } catch { cached = resumeId; }
    if (cached) {
      try { session = validate(await retry(`${base}/${cached}`, {}, 'resume-status')); }
      catch (error) { if (![404,410].includes(error.status) || resumeId) throw error; cached = null; }
      if (session && (['failed','cancelled'].includes(session.status) || (session.status === 'uploading' && Date.parse(session.expiresAt) <= Date.now()))) {
        if (resumeId) throw failure('This upload expired or was cancelled. Start a new upload.',410,'UPLOAD_EXPIRED');
        session = null; cached = null;
      }
    }
    if (!session) {
      const pending = await retry(base, {}, 'find-upload');
      if (!Array.isArray(pending)) throw failure('Could not read the upload list.',0,'INVALID_ACKNOWLEDGEMENT');
      session = pending.find(item => item.name === file.name && item.size === file.size);
      if (session) validate(session);
    }
    if (!session) {
      async function create(id) {
        try { storage?.setItem(key,id); } catch { /* Server discovery supports resume. */ }
        return validate(await retry(base, { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uploadId:id,name:file.name,size:file.size,protocol:2}) },'create-upload'));
      }
      try { session = await create(cached || uuid()); }
      catch (error) { if (error.code !== 'UPLOAD_ID_CONFLICT') throw error; session = await create(uuid()); }
    }
    apply(session); initialBytes = totalSent();
    if (accepted(session)) return session;
    chunkSize = Math.min(16*1024*1024,session.chunkSize || limits.chunkSize);
    maxInflight = session.protocol === 2 ? Math.min(3,session.maxInflight || 3) : 1;
    windowBytes = session.protocol === 2 ? session.windowBytes || 3*16*1024*1024 : chunkSize;
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || !Number.isSafeInteger(windowBytes) || windowBytes < chunkSize) throw failure('Invalid server transfer limits.',0);
    report('uploading');
    while (offset < file.size || tasks.size) {
      while (tasks.size < maxInflight && offset < file.size) {
        const {from,end} = nextRange(); if (end <= from) break;
        const chunk = file.slice(from,end);
        // One worker prepares the next bounded chunk while previous requests
        // continue transferring/committing. No full-file pass or prefix scan.
        const hash = await hasher.hash(chunk); signal.throwIfAborted();
        const task = {from,chunk,hash,loaded:0}; tasks.set(from,task);
        task.result = transfer(task).then(result => ({task,...result}), error => ({task,error}));
      }
      if (!tasks.size) { if (offset < file.size) throw failure('Upload progress could not be reconciled.',0); break; }
      const result = await Promise.race([...tasks.values()].map(task => task.result));
      tasks.delete(result.task.from);
      if (result.error) throw result.error;
      if (result.smaller) { chunkSize = Math.min(chunkSize,result.smaller); report('retrying',{message:`Proxy size limit: continuing with ${chunkSize} byte chunks.`}); }
      else report('uploading');
    }
    report('confirming');
    const result = validate(await retry(`${base}/${session.uploadId}/complete`,{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}},'complete-upload'));
    apply(result); if (!accepted(result)) throw failure('The server has not queued the upload.',0,'INVALID_ACKNOWLEDGEMENT');
    return result;
  } catch (error) {
    if (!signal.aborted) diagnostic('paused',error);
    controller.abort(error);
    await Promise.allSettled([...tasks.values()].map(task => task.result));
    error.uploadId ||= session?.uploadId; error.confirmedBytes = offset; throw error;
  } finally { hasher.close(); }
}
