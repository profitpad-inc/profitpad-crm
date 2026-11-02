import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The API runs on :3000 (api/) unless API_URL says otherwise; the dev
// server proxies /v1 to it.
//
// Four pages: the CRM app (index.html) and the public quote, form and booking
// pages (p/quote/, p/form/, p/book/), which import nothing from the app so customers only
// download the public code. embed.js is built separately (vite.embed.config.ts).
const page = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Content Security Policy as a <meta> tag on every page (GitHub Pages cannot
// send headers). Built pages only: the dev server injects inline scripts.
// Scripts only from the site itself, so injected markup (say, a form's custom
// HTML) cannot run code; requests only to the site and the API. Images may
// come from any https site (custom form HTML). frame-ancestors cannot be set
// from a meta tag.
function csp(apiUrl: string): Plugin {
  const api = apiUrl ? new URL(apiUrl).origin : '';
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${api ? ` ${api}` : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self'${api ? ` ${api}` : ''}`,
    "frame-src 'none'"
  ].join('; ');
  return {
    name: 'pcrm-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }]
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), csp(loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL ?? '')],
  server: {
    port: 5173,
    // keep the browser's Host so the API builds sign-in callbacks on this
    // origin (http://localhost:5173/v1/auth/.../callback), where its cookies are.
    // /files: public file links, which the API builds on the same origin
    proxy: {
      '/v1': { target: process.env.API_URL ?? 'http://127.0.0.1:3000', changeOrigin: false },
      '/files/': { target: process.env.API_URL ?? 'http://127.0.0.1:3000', changeOrigin: false }
    }
  },
  build: {
    rollupOptions: {
      input: {
        app: page('index.html'),
        quote: page('p/quote/index.html'),
        form: page('p/form/index.html'),
        book: page('p/book/index.html')
      }
    }
  }
}));
