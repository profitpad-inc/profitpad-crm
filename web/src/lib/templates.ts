import { api, type SearchResult } from './api';

// Objects that document templates can draw (the `object` dropdown on
// document_templates, migration 0075).
export const TEMPLATE_OBJECTS = ['quotes'];

export interface TemplateChoice { id: string; name: string; isDefault: boolean }

const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);

// The published templates for an object, by name. Quotes always have one
// default among them (migration 0080).
export async function loadTemplateChoices(object: string): Promise<TemplateChoice[]> {
  const res = await api<SearchResult>('POST', '/v1/objects/document_templates/search', {
    limit: 100,
    properties: ['name', 'is_default'],
    filter_groups: [{ filters: [{ property: 'object', operator: 'eq', value: object }, { property: 'status', operator: 'eq', value: 'published' }] }],
    sorts: [{ property: 'name', direction: 'asc' }]
  });
  return res.results.map((r) => ({
    id: r.id,
    name: (r.properties.name as string | null) || 'Untitled template',
    isDefault: String(one(r.properties.is_default)) === 'true'
  }));
}

// The picker's choices: '' is "Default (name)", which links nothing, so a
// later change of default still applies; then every other template.
export function templateOptions(templates: TemplateChoice[]): { value: string; label: string }[] {
  const def = templates.find((t) => t.isDefault);
  return [
    { value: '', label: def ? `Default (${def.name})` : 'Default' },
    ...templates.filter((t) => !t.isDefault).map((t) => ({ value: t.id, label: t.name }))
  ];
}
