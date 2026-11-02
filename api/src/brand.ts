import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { apiBaseUrl } from './auth.js';

// The CRM logo on the API host, for apps that show it: MCP clients (the
// server's icons, mcp.ts), sites that look up a domain's favicon, and the
// OAuth consent page. favicon.svg is a copy of web/public/favicon.svg; the PNG
// and ICO were rendered from it.

const asset = (name: string) => readFileSync(new URL(`./assets/${name}`, import.meta.url));
const FILES: Record<string, { body: Buffer; type: string }> = {
  '/favicon.svg': { body: asset('favicon.svg'), type: 'image/svg+xml' },
  '/favicon.ico': { body: asset('favicon.ico'), type: 'image/x-icon' },
  '/icon-512.png': { body: asset('icon-512.png'), type: 'image/png' }
};
export const BRAND_PATHS = new Set(Object.keys(FILES));

export const brandIcons = (req: FastifyRequest) => [
  { src: `${apiBaseUrl(req)}/favicon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
  { src: `${apiBaseUrl(req)}/icon-512.png`, mimeType: 'image/png', sizes: ['512x512'] }
];

export async function brandRoutes(app: FastifyInstance) {
  for (const [path, file] of Object.entries(FILES)) {
    app.get(path, async (_req, reply) => reply.type(file.type).header('cache-control', 'public, max-age=86400').send(file.body));
  }
}
