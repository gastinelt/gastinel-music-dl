import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@getpapillon/papicons': path.resolve(
        __dirname,
        'node_modules/@getpapillon/papicons/lib/module/icons-web/index.js'
      ),
    },
  },
});
