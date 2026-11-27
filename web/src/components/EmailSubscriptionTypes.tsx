import { useEffect, useState } from 'react';
import { Mailbox, MoreHorizontal, Plus } from 'lucide-react';
import { api, clearSchemaCache } from '../lib/api';
import { useApp } from '../lib/app-context';
import { Menu } from './ui';
import { confirmDialog } from './confirm';
import { SaveHint } from './SaveHint';
import { useDirty } from '../lib/use-dirty';
import { EditPanel, EmptyState, SettingsSection, StatusPill, TableSkeleton } from './settings';

// Settings → Email, Subscription types (api/src/email/topics.ts, migration
// 0157): topics of marketing email contacts can leave one at a time on the
// preference page behind the unsubscribe link. Each campaign picks one.
// They are the choices of the shared option list "Email subscription types";
// archiving keeps contacts' choices, so restoring brings them back.
// Marketing is the default every new campaign starts with (migration 0162):
// it can be renamed but not archived.

interface SubscriptionType {
  value: string;
  label: string;
  description: string | null;
  status: 'active' | 'archived';
  unsubscribed_count: number;
}

const DEFAULT_TYPE = 'marketing';

type Draft = { kind: 'new' | 'edit'; value?: string; label: string; description: string };

export function EmailSubscriptionTypes() {
  const { toast } = useApp();
  const [types, setTypes] = useState<SubscriptionType[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { dirty } = useDirty(draft ? { label: draft.label, description: draft.description } : null, draft ? `${draft.kind}:${draft.value ?? ''}` : '');

  const load = () => api<{ subscription_types: SubscriptionType[] }>('GET', '/v1/email/subscription-types?include_archived=true')
    .then((r) => setTypes(r.subscription_types))
    .catch((e) => setError((e as Error).message));
  useEffect(() => { void load(); }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      // the contacts and campaigns dropdowns changed
      clearSchemaCache();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const save = (d: Draft) => run(async () => {
    const body = { label: d.label.trim(), description: d.description.trim() };
    if (d.kind === 'new') {
      await api('POST', '/v1/email/subscription-types', body);
      toast(`${body.label} added.`);
    } else {
      await api('PATCH', `/v1/email/subscription-types/${encodeURIComponent(d.value!)}`, body);
      toast('Subscription type saved.');
    }
    setDraft(null);
  });

  const setStatus = (t: SubscriptionType, status: 'active' | 'archived') => run(async () => {
    if (status === 'archived') {
      const ok = await confirmDialog(
        `Archive ${t.label}? It leaves the preference page and campaigns can no longer pick it. Contacts' choices are kept, so restoring it brings them back.`,
        { title: 'Archive subscription type', confirmLabel: 'Archive' }
      );
      if (!ok) return;
    }
    await api('PATCH', `/v1/email/subscription-types/${encodeURIComponent(t.value)}`, { status });
    toast(status === 'archived' ? `${t.label} archived.` : `${t.label} restored.`);
  });

  const active = types?.filter((t) => t.status === 'active') ?? [];
  const archived = types?.filter((t) => t.status === 'archived') ?? [];
  const d = draft;

  return (
    <SettingsSection
      title="Subscription types"
      description="Kinds of marketing email, like a newsletter or product updates. Contacts can leave one without leaving the rest, on the page behind the unsubscribe link. Once there is one, every campaign needs a type."
      actions={!d && types && types.length > 0 ? <button className="btn" onClick={() => setDraft({ kind: 'new', label: '', description: '' })}><Plus size={14} /> New type</button> : undefined}
    >
      {error && <div className="error">{error}</div>}
      {d && (
        <EditPanel
          title={d.kind === 'new' ? 'New subscription type' : `Edit ${types?.find((t) => t.value === d.value)?.label ?? 'subscription type'}`}
          onSubmit={() => save(d)}
          footer={<>
            <SaveHint missing={[!d.label.trim() && 'a name']} />
            <button className="btn" type="button" onClick={() => { setDraft(null); setError(null); }}>Cancel</button>
            <button className="btn primary" type="submit" disabled={busy || !d.label.trim() || (d.kind === 'edit' && !dirty)}>
              {d.kind === 'new' ? 'Add type' : 'Save'}
            </button>
          </>}
        >
          <label>Name
            <input value={d.label} maxLength={63} required placeholder="Newsletter" autoFocus onChange={(e) => setDraft({ ...d, label: e.target.value })} />
          </label>
          <label>Description (optional)
            <input value={d.description} maxLength={500} placeholder="Our monthly roundup of news and tips"
              onChange={(e) => setDraft({ ...d, description: e.target.value })} />
          </label>
          <p className="muted small">Contacts see the name and description on the preference page, and the email footer names the type.</p>
        </EditPanel>
      )}
      {!types && !error && <TableSkeleton rows={2} />}
      {types && types.length === 0 && !d && (
        <EmptyState compact icon={<Mailbox size={18} />} title="No subscription types"
          action={<button className="btn" onClick={() => setDraft({ kind: 'new', label: '', description: '' })}><Plus size={14} /> New type</button>}>
          Unsubscribing stops all marketing email.
        </EmptyState>
      )}
      {types && types.length > 0 && (
        <div className="access-table">
          <table className="grid">
            <thead>
              <tr><th>Type</th><th>Unsubscribed</th><th /></tr>
            </thead>
            <tbody>
              {[...active, ...archived].map((t) => (
                <tr key={t.value}>
                  <td className="primary-cell wrap">
                    {t.label} {t.value === DEFAULT_TYPE && <StatusPill tone="info">Default</StatusPill>} {t.status === 'archived' && <StatusPill tone="off">Archived</StatusPill>}
                    {t.description && <span className="sub">{t.description}</span>}
                  </td>
                  <td>{t.unsubscribed_count.toLocaleString()} contact{t.unsubscribed_count === 1 ? '' : 's'}</td>
                  <td className="row-actions">
                    <Menu align="right" trigger={(open) => <button className="icon-btn" onClick={open} aria-label={`Actions for ${t.label}`}><MoreHorizontal size={16} /></button>}>
                      {(close) => (
                        <>
                          <button onClick={() => { close(); setDraft({ kind: 'edit', value: t.value, label: t.label, description: t.description ?? '' }); }}>Edit</button>
                          {t.value === DEFAULT_TYPE ? null : t.status === 'active'
                            ? <button className="danger" onClick={() => { close(); void setStatus(t, 'archived'); }}>Archive</button>
                            : <button onClick={() => { close(); void setStatus(t, 'active'); }}>Restore</button>}
                        </>
                      )}
                    </Menu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsSection>
  );
}
