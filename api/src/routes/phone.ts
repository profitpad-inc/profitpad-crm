import type { FastifyInstance } from 'fastify';
import { requireScope } from '../auth.js';
import { badRequest } from '../errors.js';
import { checkPhone, DEFAULT_REGION, isRegion } from '../phone.js';

// POST /v1/phone/validate: checks and formats a phone number with Google's
// libphonenumber, the same check every phone property and form phone field
// gets. Needs an API key (any scope that can read).
export async function phoneRoutes(app: FastifyInstance) {
  app.post<{ Body: { number?: unknown; region?: unknown } }>('/v1/phone/validate', { bodyLimit: 4 * 1024 }, async (req) => {
    requireScope(req.principal!, 'read');
    const b = req.body ?? {};
    if (typeof b.number !== 'string') throw badRequest('number must be a string');
    const region = b.region === undefined || b.region === null ? DEFAULT_REGION : String(b.region).toUpperCase();
    if (!isRegion(region)) throw badRequest(`unknown region "${region}" (use a two-letter country code like CA or GB)`);
    return checkPhone(b.number, region);
  });
}
