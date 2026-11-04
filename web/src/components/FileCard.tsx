import { useEffect, useState } from 'react';
import { Copy, Download, ExternalLink, File as FileIcon, Globe } from 'lucide-react';
import { api, type CrmRecord } from '../lib/api';
import { useApp } from '../lib/app-context';
import { StatusPill } from './settings';
import { fileInfo, fileLink, formatBytes, openFile, type FileInfo } from '../lib/files';
import { confirmDialog } from './confirm';

const PREVIEW = /^(image\/(png|jpeg|gif|webp|avif)|video\/|audio\/)/;

// Record page card for a file: a preview for images, video and audio, open
// and download buttons, and the public link (on, copy, off).
export function FileCard({ record }: { record: CrmRecord }) {
  const { toast } = useApp();
  const [file, setFile] = useState<FileInfo | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fileInfo([record.id]).then(async ([f]) => {
      if (!live) return;
      setFile(f ?? null);
      if (f?.status === 'ready' && f.mime_type && PREVIEW.test(f.mime_type)) {
        const url = await fileLink(f.id);
        if (live) setPreview(url);
      }
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

  const open = (download: boolean) => openFile(record.id, download).catch((err) => setError((err as Error).message));
  const type = file?.mime_type ?? '';

  return (
    <div className="card file-card">
      <div className="card-head">
        <span className="card-icon"><FileIcon size={15} strokeWidth={1.75} /></span>
        <h3>File</h3>
      </div>
      {!file && !error && <div className="file-preview-skeleton" aria-busy="true" aria-label="Loading file" />}
      {file && file.status !== 'ready' && <div className="muted small">This file has not finished uploading.</div>}
      {preview && type.startsWith('image/') && <img className="file-preview" src={preview} alt={file?.name ?? ''} />}
      {preview && type.startsWith('video/') && <video className="file-preview" src={preview} controls preload="metadata" />}
      {preview && type.startsWith('audio/') && <audio src={preview} controls preload="metadata" />}
      {file && (
        <div className="muted small">{[type || 'Unknown type', formatBytes(file.size_bytes)].filter(Boolean).join(', ')}</div>
      )}
      {file?.status === 'ready' && (
        <>
          <div className="public-link-actions">
            <button className="btn small" onClick={() => open(false)}><ExternalLink size={14} /> Open</button>
            <button className="btn small" onClick={() => open(true)}><Download size={14} /> Download</button>
          </div>
          <div className="file-public-head">
            <Globe size={13} aria-hidden /> Public link
            <span className="push-right"><StatusPill tone={file.public_url ? 'on' : 'off'}>{file.public_url ? 'On' : 'Off'}</StatusPill></span>
          </div>
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
