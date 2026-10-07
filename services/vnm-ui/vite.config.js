import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __SAVE_SYNC_VERSION__: JSON.stringify(createHash('sha256').update(readFileSync('./public/save-sync.js')).digest('hex')),
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://vnm-api:3001',
        changeOrigin: true,
      },
    },
  },
});
