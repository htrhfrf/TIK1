import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..');
export default defineConfig({
  root: rootDir,
  plugins: [react(), tailwindcss()],
  server: { port: 5173, host: '0.0.0.0', allowedHosts: true, proxy: { '/api': 'http://127.0.0.1:3000', '/files': 'http://127.0.0.1:3000' } },
  build: { outDir: path.resolve(here, 'dist'), emptyOutDir: true },
});
