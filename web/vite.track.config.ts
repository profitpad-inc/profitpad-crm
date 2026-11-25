import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// track.js for customer websites (page view tracking): one self-contained
// script at dist/p/track.js (a stable path, so websites can hard-code it). Runs after
// the main build, which it must not wipe.
export default defineConfig({
  build: {
    outDir: 'dist/p',
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: fileURLToPath(new URL('src/public/track.ts', import.meta.url)),
      formats: ['iife'],
      name: 'ProfitPadTrack',
      fileName: () => 'track.js'
    }
  }
});
