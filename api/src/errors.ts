import { cachedPropertyById } from './registry.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'error',
    public details?: unknown
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new ApiError(400, message, 'invalid_request', details);
export const notFound = (message: string) => new ApiError(404, message, 'not_found');
export const forbidden = (message: string) => new ApiError(403, message, 'forbidden');

// SQLSTATEs raised by the meta.* functions and Postgres itself.
const PG_STATUS: Record<string, [number, string]> = {
  '22023': [400, 'invalid_request'],
  '22P02': [400, 'invalid_request'],
  '22007': [400, 'invalid_request'],
  '22008': [400, 'invalid_request'],
  '22003': [400, 'invalid_request'],
  '23514': [400, 'rule_violation'],
  '23505': [409, 'conflict'],
  '55006': [409, 'blocked_by_dependencies'],
  P0002: [404, 'not_found'],
  '42501': [403, 'forbidden'],
  '57014': [504, 'timeout']
};

export function fromPg(err: unknown): ApiError | null {
  const code = (err as { code?: string })?.code;
  if (!code || !PG_STATUS[code]) return null;
  const [status, kind] = PG_STATUS[code];
  const pgErr = err as { message: string; detail?: string; constraint?: string };
  // unique properties are enforced by indexes named pci_<property id>_uq
  const unique = code === '23505' && /^pci_(\w+)_uq$/.exec(pgErr.constraint ?? '');
  const found = unique ? cachedPropertyById(unique[1]) : null;
  if (found) {
    return new ApiError(status, `Another ${found.obj.label_singular.toLowerCase()} already uses this ${found.prop.label.toLowerCase()}. Choose a different one.`, kind,
      { property: found.prop.api_name });
  }
  return new ApiError(status, pgErr.message, kind, pgErr.detail ? { detail: pgErr.detail, constraint: pgErr.constraint } : undefined);
}
