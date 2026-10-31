import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API runs on :3000 (api/) unless API_URL says otherwise; the dev
// server proxies /v1 to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/v1': process.env.API_URL ?? 'http://127.0.0.1:3000' }
  }
});
