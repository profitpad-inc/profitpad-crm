// The full address of a record's page in the CRM, for MCP answers that should
// hand the user a link they can click. Without UI_URL (local dev) it falls back
// to the path alone.
const uiBase = () => (process.env.UI_URL ?? '').replace(/\/$/, '');

export const recordUrl = (object: string, id: string) => `${uiBase()}/objects/${object}/${encodeURIComponent(id)}`;
