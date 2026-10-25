import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: 'client', plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./client/src', import.meta.url)) } },
  build: { outDir: '../dist/client', emptyOutDir: false },
  server: { proxy: { '/api': 'http://127.0.0.1:4387' } },
});
