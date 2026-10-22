import { sha256 } from '@noble/hashes/sha2.js';
self.onmessage = async event => {
  const { id, file } = event.data;
  try {
    const hash = sha256.create();
    let last = 0;
    for (let offset = 0; offset < file.size; offset += 8 * 1024 * 1024) {
      const bytes = new Uint8Array(await file.slice(offset, offset + 8 * 1024 * 1024).arrayBuffer());
      hash.update(bytes);
      if (Date.now() - last >= 100 || offset + bytes.length === file.size) {
        last = Date.now(); self.postMessage({ id, loaded: offset + bytes.length });
      }
    }
    self.postMessage({ id, checksum: Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('') });
  } catch (error) { self.postMessage({ id, error: error.message || 'Could not read the selected archive.' }); }
};
