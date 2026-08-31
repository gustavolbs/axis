import path from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const dashboardRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: dashboardRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.join(dashboardRoot, 'src')
    }
  },
  build: {
    outDir: path.join(dashboardRoot, 'dist'),
    emptyOutDir: true,
    sourcemap: false
  }
});
