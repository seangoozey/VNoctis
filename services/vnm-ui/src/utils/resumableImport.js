import { createImportHasher } from './importHash.js';

const base = '/api/v1/library/import-uploads';
const fullChecksums = new WeakMap();
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

/** Bounded, sequential chunks. Only durable server offsets advance confirmed progress. */
export async function uploadGameArchive(file, {
  signal, onProgress = () => {}, onDiagnostic = () => {}, resumeId,
  identity = importIdentity, request = importRequest, hasherFactory = createImportHasher,
  storage = globalThis.localStorage, delay = defaultDelay, maxRetries = 5,
} = {}) {
  const owner = identity().userId, hasher = hasherFactory(signal), started = Date.now();
  let session, key, offset = 0, transferStart = 0, initialOffset = 0, lastConfirmedAt = null;
  function diagnostic(stage, error, details = {}) {
    const entry = { time: new Date().toISOString(), uploadId: session?.uploadId || resumeId || null, stage,
      name: error.name || 'Error', message: error.message, status: error.status || null, code: error.code || null, confirmedBytes: offset, ...details };
    console.warn('[VNoctis import upload]', JSON.stringify(entry)); onDiagnostic(entry);
  }
  function report(stage, extra = {}) {
    const elapsedMs = Date.now() - (transferStart || started);
    const sent = extra.sentBytes ?? offset;
    onProgress({ stage, uploadId: session?.uploadId || null, size: file.size, confirmedBytes: offset,
      sentBytes: offset, elapsedMs, lastConfirmedAt, bytesPerSecond: transferStart ? Math.max(0, sent - initialOffset) / Math.max(1, elapsedMs / 1000) : 0, ...extra });
  }
  async function call(path, options = {}) {
    signal?.throwIfAborted();
    const auth = identity();
    if (auth.userId !== owner) throw failure('The signed-in account changed. Reselect the archive after signing in.', 403, 'ACCOUNT_CHANGED');
    return request(path, { ...options, signal, headers: { ...options.headers, Authorization: `Bearer ${auth.token}` } });
  }
  async function retry(path, options, stage) {
    for (let attempt = 0; ; attempt++) {
      try { return await call(path, options); }
      catch (error) {
        if (signal?.aborted) throw signal.reason;
        diagnostic(stage, error, { attempt: attempt + 1 });
        if (!transient(error) || attempt >= maxRetries) throw error;
        report('retrying', { message: error.message, attempt: attempt + 1 });
        await delay(Math.min(16000, 1000 * 2 ** attempt), signal);
      }
    }
  }
  function validate(state, checksum) {
    if (!state || typeof state.uploadId !== 'string' || state.checksum !== checksum || state.size !== file.size || !Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset > file.size) throw failure('Server upload identity or offset does not match this archive.', 409, 'UPLOAD_IDENTITY_MISMATCH');
    return state;
  }
  function accepted(state) {
    if (['queued', 'running', 'done'].includes(state.status)) {
      try { storage?.removeItem(key); } catch { /* Server discovery also supports resume. */ }
      report('accepted', { jobId: state.jobId }); return state;
    }
    return null;
  }
  try {
    if (!file.size || !/\.(zip|tar\.bz2|rar)$/i.test(file.name)) throw failure('Select a non-empty .zip, .tar.bz2 or .rar archive.', 400);
    report('connecting');
    let limits;
    try { limits = await retry(base + '/limits', {}, 'upload-limits'); }
    catch (error) { if (error.status === 404) throw failure('Update the API and UI together to enable resumable imports.', 404, 'SERVER_UPDATE_REQUIRED'); throw error; }
    if (!Number.isSafeInteger(limits.maxBytes) || file.size > limits.maxBytes) throw failure('The selected archive exceeds the server import size limit.', 400, 'UPLOAD_TOO_LARGE');
    report('checking', { checkedBytes: 0 });
    const checksum = fullChecksums.get(file) || await hasher.hash(file, checkedBytes => report('checking', { checkedBytes }));
    fullChecksums.set(file, checksum);
    key = `vnm-import-upload:${owner}:${encodeURIComponent(file.name)}:${file.size}:${checksum}`;
    let cached;
    try { cached = resumeId || storage?.getItem(key); } catch { cached = resumeId; }
    report('connecting');
    if (cached) {
      try { session = validate(await retry(`${base}/${cached}`, {}, 'resume-status'), checksum); }
      catch (error) { if (![404, 410].includes(error.status) || resumeId) throw error; cached = null; }
      if (session && (['failed', 'cancelled'].includes(session.status) || (session.status === 'uploading' && Date.parse(session.expiresAt) <= Date.now()))) {
        if (resumeId) throw failure('This upload expired or was cancelled. Cancel its record or start a new upload.', 410, 'UPLOAD_EXPIRED');
        session = null; cached = null;
      }
    }
    if (!session) {
      const pending = await retry(base, {}, 'find-upload');
      if (!Array.isArray(pending)) throw failure('Could not read the server upload list.', 0, 'INVALID_ACKNOWLEDGEMENT');
      session = pending.find(item => item.name === file.name && item.size === file.size && item.checksum === checksum);
      if (session) validate(session, checksum);
    }
    if (!session) {
      const uploadId = cached && !resumeId ? cached : uuid();
      try { storage?.setItem(key, uploadId); } catch { /* Not required for server discovery. */ }
      const body = JSON.stringify({ uploadId, name: file.name, size: file.size, checksum });
      try { session = validate(await retry(base, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }, 'create-upload'), checksum); }
      catch (error) {
        if (error.code !== 'UPLOAD_ID_CONFLICT') throw error;
        const replacementId = uuid();
        try { storage?.setItem(key, replacementId); } catch { /* Optional recovery hint. */ }
        session = validate(await retry(base, { method: 'POST', body: JSON.stringify({ uploadId: replacementId, name: file.name, size: file.size, checksum }), headers: { 'Content-Type': 'application/json' } }, 'create-upload'), checksum);
      }
    }
    offset = session.offset;
    if (accepted(session)) return session;
    transferStart = Date.now(); initialOffset = offset;
    report('uploading');
    let chunkSize = Math.min(16 * 1024 * 1024, session.chunkSize || 16 * 1024 * 1024);
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw failure('Invalid server chunk size.', 0);
    while (offset < file.size) {
      const chunk = file.slice(offset, Math.min(file.size, offset + chunkSize));
      report('preparing-chunk');
      const chunkHash = await hasher.hash(chunk);
      for (let attempt = 0; ; attempt++) {
        const from = offset;
        try {
          const state = validate(await call(`${base}/${session.uploadId}/chunk?offset=${from}`, { method: 'PUT', body: chunk,
            headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': chunkHash },
            onProgress: loaded => report('uploading', { sentBytes: from + loaded, lastNetworkProgressAt: Date.now() }),
            onSent: () => report('confirming-chunk', { sentBytes: from + chunk.size, lastNetworkProgressAt: Date.now() }),
          }), checksum);
          if (state.offset < from + chunk.size) throw failure('The server did not confirm this chunk.', 0, 'INVALID_ACKNOWLEDGEMENT');
          offset = state.offset; session = state; lastConfirmedAt = Date.now(); report('uploading'); break;
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          diagnostic('chunk', error, { attempt: attempt + 1, offset: from, chunkBytes: chunk.size });
          if (error.status === 413 && chunkSize > 256 * 1024) { chunkSize = Math.max(256 * 1024, Math.floor(Math.min(chunkSize, chunk.size) / 2)); report('retrying', { message: `Proxy size limit: retrying with ${chunkSize} byte chunks.` }); break; }
          if (!transient(error) || ['UPLOAD_CHUNK_CONFLICT', 'UPLOAD_IDENTITY_MISMATCH', 'UPLOAD_NOT_ACTIVE'].includes(error.code) || attempt >= maxRetries) throw error;
          report('retrying', { message: error.message, attempt: attempt + 1 });
          await delay(Math.min(16000, 1000 * 2 ** attempt), signal);
          let latest;
          try { latest = validate(await call(`${base}/${session.uploadId}`), checksum); }
          catch (statusError) { diagnostic('resume-status', statusError); if (!transient(statusError) || statusError.code === 'UPLOAD_IDENTITY_MISMATCH') throw statusError; }
          if (latest) {
            if (accepted(latest)) return latest;
            if (latest.status !== 'uploading') throw failure('The upload was cancelled or expired. Start a new upload.', 410, 'UPLOAD_EXPIRED');
            if (latest.offset !== offset) { offset = latest.offset; session = latest; lastConfirmedAt = Date.now(); report('uploading'); break; }
          }
        }
      }
    }
    report('confirming');
    const result = validate(await retry(`${base}/${session.uploadId}/complete`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }, 'complete-upload'), checksum);
    if (!accepted(result)) throw failure('The server has not queued the completed archive.', 0, 'INVALID_ACKNOWLEDGEMENT');
    return result;
  } catch (error) {
    if (!signal?.aborted) diagnostic('paused', error);
    error.uploadId ||= session?.uploadId;
    error.confirmedBytes = offset;
    throw error;
  } finally { hasher.close(); }
}
