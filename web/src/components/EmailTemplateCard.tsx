import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import { api, type CrmRecord } from '../lib/api';
import { useApp } from '../lib/app-context';
import { CodeBlock } from './CodeBlock';
import { HtmlEditorModal, htmlPreviewDoc } from './HtmlEditor';
import { useFillColumn } from '../lib/use-fill-column';

const WRAP_KEY = 'pcrm.viewCodeWrap';

function readWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) === '1';
  } catch {
    return false;
  }
}

// An email template's Preview tab, laid out like a landing page's: the body as
// it is drawn (merge tags such as {{ contact.first_name }} show as written) or
// its HTML, running to the bottom of the record's middle column, with Edit for
// those who may change it. The campaigns using the template are in the right column.
export function EmailTemplateCard({ record, canEdit, onChanged }: { record: CrmRecord; canEdit: boolean; onChanged: (r: CrmRecord) => void }) {
  const { toast } = useApp();
  const [tab, setTab] = useState<'preview' | 'html'>('preview');
  const [wrap, setWrap] = useState(readWrap);
  const [editing, setEditing] = useState(false);
  const html = typeof record.properties.body === 'string' ? record.properties.body : '';
  const subject = typeof record.properties.subject === 'string' ? record.properties.subject : '';
  const { ref: bodyRef, height: bodyHeight } = useFillColumn<HTMLDivElement>([tab, !!html]);

  useEffect(() => {
    try {
      localStorage.setItem(WRAP_KEY, wrap ? '1' : '0');
    } catch {
      // per-viewer convenience only
    }
  }, [wrap]);

  return (
    <div className="card">
      <div className="card-head">
        <h3>Email</h3>
        {subject && <span className="muted small">{subject}</span>}
        <span style={{ flex: 1 }} />
        {canEdit && <button className="btn small" onClick={() => setEditing(true)}><Pencil size={12} /> Edit</button>}
      </div>
      <div className="tabs">
        <span style={{ flex: 1 }} />
        {tab === 'html' && (
          <label className="small muted code-wrap-toggle">
            <input type="checkbox" role="switch" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap lines
          </label>
        )}
        <div className={`tab${tab === 'preview' ? ' active' : ''}`}><button onClick={() => setTab('preview')}>Preview</button></div>
        <div className={`tab${tab === 'html' ? ' active' : ''}`}><button onClick={() => setTab('html')}>HTML</button></div>
      </div>
      {!html ? (
        <p className="muted">No body yet.{canEdit ? ' Press Edit to write one, or ask your AI to through the CRM\'s MCP connection.' : ''}</p>
      ) : (
        <div ref={bodyRef} className="landing-body" style={bodyHeight ? { height: bodyHeight } : undefined}>
          {tab === 'preview'
            ? <iframe className="landing-preview" title="Email preview" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={htmlPreviewDoc(html)} />
            : <CodeBlock text={html} wrap={wrap} lang="html" />}
        </div>
      )}
      {editing && (
        <HtmlEditorModal
          title="Edit email body"
          value={html}
          onClose={() => setEditing(false)}
          onSave={async (next) => {
            onChanged(await api<CrmRecord>('PATCH', `/v1/objects/email_templates/${record.id}`, { properties: { body: next.trim() ? next : null } }));
            setEditing(false);
            toast('Saved');
          }}
        />
      )}
    </div>
  );
}
