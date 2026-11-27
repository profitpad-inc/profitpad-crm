import { useEffect, useState } from 'react';
import { api, type SearchResult } from './api';
import type { CampaignChoice, ListChoice } from './filters';

// Every list the user can read (name and object), for the "List membership"
// filter. Empty when there are none or lists can't be read.
export async function loadListChoices(): Promise<ListChoice[]> {
  const r = await api<SearchResult>('QUERY', '/v1/objects/lists/search', {
    limit: 200, properties: ['name', 'list_object'], sorts: [{ property: 'name', direction: 'asc' }]
  });
  return r.results.map((l) => ({ id: l.id, name: String(l.properties.name ?? 'Untitled list'), list_object: String(l.properties.list_object ?? '') }));
}

export function useListChoices(enabled = true): ListChoice[] {
  const [lists, setLists] = useState<ListChoice[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    loadListChoices().then((l) => live && setLists(l)).catch(() => undefined);
    return () => { live = false; };
  }, [enabled]);
  return lists;
}

// Campaigns that have gone out (or started to), newest first, for the
// "Email campaign: opened" filters on contacts. Empty when none, or when
// campaigns can't be read.
export function useCampaignChoices(enabled = true): CampaignChoice[] {
  const [campaigns, setCampaigns] = useState<CampaignChoice[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api<SearchResult>('QUERY', '/v1/objects/email_campaigns/search', {
      limit: 200, properties: ['name'], sorts: [{ property: 'created_at', direction: 'desc' }],
      filter_groups: [{ filters: [{ property: 'status', operator: 'in', values: ['sending', 'sent', 'canceled'] }] }]
    }).then((r) => live && setCampaigns(r.results.map((c) => ({ id: c.id, name: String(c.properties.name ?? 'Untitled campaign') }))))
      .catch(() => undefined);
    return () => { live = false; };
  }, [enabled]);
  return campaigns;
}
