export function createImportHasher(signal) {
  const worker = new Worker(new URL('../workers/import-hash.js', import.meta.url), { type: 'module' });
  let next = 0, pending = null, closed = false;
  const abort = () => close(signal?.reason || new DOMException('Upload paused', 'AbortError'));
  function close(error = new DOMException('File check stopped', 'AbortError')) {
    if (closed) return;
    closed = true; worker.terminate(); signal?.removeEventListener('abort', abort);
    pending?.reject(error); pending = null;
  }
  worker.onmessage = ({ data }) => {
    if (!pending || pending.id !== data.id) return;
    if (data.error) { pending.reject(new Error(data.error)); pending = null; }
    else if (data.checksum) { pending.resolve(data.checksum); pending = null; }
    else pending.progress?.(data.loaded);
  };
  worker.onerror = event => close(new Error(event.message || 'Archive checksum worker failed.'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return {
    hash(file, progress) {
      if (closed) return Promise.reject(signal?.reason || new DOMException('File check stopped', 'AbortError'));
      if (pending) return Promise.reject(new Error('An archive check is already running.'));
      return new Promise((resolve, reject) => { pending = { id: ++next, resolve, reject, progress }; worker.postMessage({ id: next, file }); });
    },
    close,
  };
}
