import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API runs on :3000 (api/) unless API_URL says otherwise; the dev
// server proxies /v1 to it.
//
// Three pages: the CRM app (index.html) and the public quote and form pages
// (p/quote/, p/form/), which import nothing from the app so customers only
// download the public code. embed.js is built separately (vite.embed.config.ts).
const page = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // keep the browser's Host so the API builds sign-in callbacks on this
    // origin (http://localhost:5173/v1/auth/.../callback), where its cookies are
    proxy: { '/v1': { target: process.env.API_URL ?? 'http://127.0.0.1:3000', changeOrigin: false } }
  },
  build: {
    rollupOptions: {
      input: {
        app: page('index.html'),
        quote: page('p/quote/index.html'),
        form: page('p/form/index.html')
      }
    }
  }
});
