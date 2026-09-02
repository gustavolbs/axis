import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(path.resolve(root, '..', 'package.json'), 'utf8')) as { version: string };

export default defineConfig({
  root,
  base: './',
  define: {
    __AXIS_VERSION__: JSON.stringify(packageJson.version)
  },
  plugins: [react()],
  build: {
    outDir: path.resolve(root, '..', 'app-dist'),
    emptyOutDir: true,
    sourcemap: true
  }
});
