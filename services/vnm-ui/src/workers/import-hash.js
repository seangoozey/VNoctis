import { sha256 } from '@noble/hashes/sha2.js';
self.onmessage = async event => {
  const { id, file } = event.data;
  try {
    if (file.size > 16 * 1024 * 1024) throw new Error('Only bounded upload chunks may be hashed.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = self.crypto?.subtle ? new Uint8Array(await self.crypto.subtle.digest('SHA-256', bytes)) : sha256(bytes);
    self.postMessage({ id, checksum: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') });
  } catch (error) { self.postMessage({ id, error: error.message || 'Could not read the selected archive.' }); }
};
