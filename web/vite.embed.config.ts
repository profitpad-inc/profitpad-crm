import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// embed.js for customer websites: one self-contained classic script at
// dist/p/embed.js (a stable path, so websites can hard-code it). Runs after
// the main build, which it must not wipe.
export default defineConfig({
  build: {
    outDir: 'dist/p',
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: fileURLToPath(new URL('src/public/embed.ts', import.meta.url)),
      formats: ['iife'],
      name: 'ProfitPadForms',
      fileName: () => 'embed.js'
    }
  }
});
