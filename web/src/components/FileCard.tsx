import { useEffect, useState } from 'react';
import { Copy, ExternalLink, Globe } from 'lucide-react';
import { api, type CrmRecord } from '../lib/api';
import { useApp } from '../lib/app-context';
import { StatusPill } from './settings';
import { fileInfo, type FileInfo } from '../lib/files';
import { confirmDialog } from './confirm';

// Record page card for a file: the public link (on, copy, off). The file
// itself, with Open and Download, is in the middle column (FileViewer.tsx).
export function FileCard({ record }: { record: CrmRecord }) {
  const { toast } = useApp();
  const [file, setFile] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fileInfo([record.id]).then(([f]) => {
      if (live) setFile(f ?? null);
    }).catch((err) => live && setError((err as Error).message));
    return () => {
      live = false;
    };
  }, [record.id]);

  async function setPublic(on: boolean) {
    if (!on && !(await confirmDialog('Anyone who has it can no longer open the file.', { title: 'Turn off the public link?', confirmLabel: 'Turn off', danger: true }))) return;
    setBusy(true);
    setError(null);
    try {
      setFile(await api<FileInfo>(on ? 'POST' : 'DELETE', `/v1/files/${record.id}/public`));
      toast(on ? 'Public link on' : 'Public link off');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Link copied');
    } catch {
      setError('Could not copy; select the link and copy it instead.');
    }
  }

  if (file && file.status !== 'ready') return null;

  return (
    <div className="card file-card">
      <div className="card-head">
        <span className="card-icon"><Globe size={15} strokeWidth={1.75} /></span>
        <h3>Public link</h3>
        <span className="push-right">{file && <StatusPill tone={file.public_url ? 'on' : 'off'}>{file.public_url ? 'On' : 'Off'}</StatusPill>}</span>
      </div>
      {!file && !error && <div className="file-preview-skeleton short" aria-busy="true" aria-label="Loading public link" />}
      {file && (
        <>
          {file.public_url ? (
            <>
              <div className="public-link-row url">
                <input readOnly value={file.public_url} onFocus={(e) => e.target.select()} aria-label="Public link" />
                <button className="icon-btn" onClick={() => copy(file.public_url!)} aria-label="Copy link"><Copy size={15} /></button>
                <a className="icon-btn" href={file.public_url} target="_blank" rel="noreferrer" aria-label="Open public link"><ExternalLink size={15} /></a>
              </div>
              <div className="public-link-actions">
                <button className="btn small ghost danger-text" disabled={busy} onClick={() => setPublic(false)}>Turn off</button>
              </div>
            </>
          ) : (
            <>
              <div className="muted small">Only people who can see this file in the CRM can open it.</div>
              <div className="public-link-actions">
                <button className="btn small" disabled={busy} onClick={() => setPublic(true)}>Make public link</button>
              </div>
            </>
          )}
        </>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
