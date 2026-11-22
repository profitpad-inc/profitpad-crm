import { Suspense, lazy, useEffect, useState, type ComponentType } from 'react';
import { Download, ExternalLink, File as FileIcon, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Presentation } from 'lucide-react';
import { type CrmRecord } from '../lib/api';
import { fileInfo, fileLink, formatBytes, openFile, type FileInfo } from '../lib/files';
import { Loading } from './Loading';

const PdfPages = lazy(() => import('./PdfPages'));

// The types the API serves inline (INLINE_TYPES in api/src/files.ts); anything
// else only downloads, so it gets the icon tile instead of a preview.
const IMAGE = /^image\/(png|jpeg|gif|webp|avif)$/;
const TEXT_PREVIEW_BYTES = 64 * 1024;
const TEXT_SHOW_ALL_BYTES = 1024 * 1024;

type Kind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'other';

function kindOf(type: string): Kind {
  if (IMAGE.test(type)) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf') return 'pdf';
  if (type === 'text/plain') return 'text';
  return 'other';
}

function iconFor(type: string, name: string): ComponentType<{ size?: number; strokeWidth?: number }> {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (type.startsWith('image/')) return FileImage;
  if (type.startsWith('video/')) return FileVideo;
  if (type.startsWith('audio/')) return FileAudio;
  if (/spreadsheet|excel|csv/.test(type) || ['xls', 'xlsx', 'csv', 'ods', 'numbers'].includes(ext)) return FileSpreadsheet;
  if (/presentation|powerpoint/.test(type) || ['ppt', 'pptx', 'odp', 'key'].includes(ext)) return Presentation;
  if (/zip|compressed|tar|rar|7z|gzip/.test(type) || ['zip', 'rar', '7z', 'tar', 'gz', 'tgz'].includes(ext)) return FileArchive;
  if (/json|xml|html|javascript|css/.test(type) || ['json', 'xml', 'html', 'htm', 'js', 'ts', 'css', 'sql', 'py'].includes(ext)) return FileCode;
  if (type.startsWith('text/') || /pdf|word|document|rtf/.test(type) || ['doc', 'docx', 'odt', 'rtf', 'pdf', 'txt', 'md'].includes(ext)) return FileText;
  return FileIcon;
}

// The file itself, front and centre on a file record: images, video, audio,
// PDFs and plain text preview in place; anything else gets a large type icon
// with Open and Download.
export function FileViewer({ record }: { record: CrmRecord }) {
  const [file, setFile] = useState<FileInfo | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the preview could not be shown (a broken image, an unreadable PDF): the tile instead
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setFile(null);
    setUrl(null);
    setFailed(null);
    setError(null);
    fileInfo([record.id]).then(async ([f]) => {
      if (!live) return;
      setFile(f ?? null);
      if (f?.status === 'ready' && f.mime_type && kindOf(f.mime_type) !== 'other') {
        const link = await fileLink(f.id);
        if (live) setUrl(link);
      }
    }).catch((err) => live && setError((err as Error).message));
    return () => {
      live = false;
    };
  }, [record.id]);

  const open = (download: boolean) => openFile(record.id, download).catch((err) => setError((err as Error).message));
  const type = file?.mime_type ?? '';
  const name = file?.name ?? 'Untitled file';
  const kind = failed ? 'other' : kindOf(type);
  const ready = file?.status === 'ready';
  const Icon = iconFor(type, name);
  const details = file ? [type || 'Unknown type', formatBytes(file.size_bytes)].filter(Boolean).join(', ') : '';

  return (
    <div className="card file-viewer">
      <div className="file-viewer-head">
        <div className="file-viewer-title">
          <h2 title={name}>{file ? name : '\u00a0'}</h2>
          <div className="muted small">{details}</div>
        </div>
        {ready && (
          <div className="file-viewer-actions">
            <button className="btn small" onClick={() => open(false)}><ExternalLink size={14} /> Open</button>
            <button className="btn small" onClick={() => open(true)}><Download size={14} /> Download</button>
          </div>
        )}
      </div>

      <div className={`file-stage ${kind}`}>
        {!file && !error && <div className="file-preview-skeleton file-stage-skeleton" aria-busy="true" aria-label="Loading file" />}
        {file && !ready && <div className="file-stage-note muted">This file has not finished uploading.</div>}
        {ready && kind !== 'other' && !url && <Loading label="Loading preview" />}

        {ready && url && kind === 'image' && (
          <button className="file-stage-image" onClick={() => open(false)} title="Open in a new tab" aria-label={`Open ${name} in a new tab`}>
            <img src={url} alt={name} onError={() => setFailed('This image could not be shown.')} />
          </button>
        )}
        {ready && url && kind === 'video' && (
          <video src={url} controls preload="metadata" onError={() => setFailed('This video cannot play in the browser.')} />
        )}
        {ready && url && kind === 'audio' && (
          <div className="file-stage-audio">
            <span className="file-stage-icon"><FileAudio size={44} strokeWidth={1.25} /></span>
            <audio src={url} controls preload="metadata" onError={() => setFailed('This audio cannot play in the browser.')} />
          </div>
        )}
        {ready && url && kind === 'pdf' && (
          <Suspense fallback={<Loading label="Loading PDF" />}>
            <PdfPages url={url} onError={() => setFailed('This PDF could not be shown.')} />
          </Suspense>
        )}
        {ready && url && kind === 'text' && <TextPreview url={url} size={file.size_bytes} onError={() => setFailed('This text could not be shown.')} />}

        {ready && kind === 'other' && (
          <div className="file-stage-tile">
            <span className="file-stage-icon"><Icon size={56} strokeWidth={1.25} /></span>
            <div className="file-stage-name">{name}</div>
            <div className="muted small">{failed ?? 'No preview for this type of file.'}</div>
            <div className="file-viewer-actions">
              <button className="btn" onClick={() => open(false)}><ExternalLink size={15} /> Open</button>
              <button className="btn primary" onClick={() => open(true)}><Download size={15} /> Download</button>
            </div>
          </div>
        )}
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

// Plain text: the first 64 KB (a range request), with Show all up to 1 MB.
function TextPreview({ url, size, onError }: { url: string; size: number | null; onError: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const cut = !all && size !== null && size > TEXT_PREVIEW_BYTES;

  useEffect(() => {
    let live = true;
    const headers: HeadersInit = all ? {} : { range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` };
    fetch(url, { headers })
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText);
        return res.arrayBuffer();
      })
      .then((buf) => live && setText(new TextDecoder().decode(buf)))
      .catch(() => live && onError());
    return () => {
      live = false;
    };
  }, [url, all]);

  if (text === null) return <Loading label="Loading text" />;
  return (
    <div className="file-stage-text">
      <pre>{text}</pre>
      {cut && (
        <div className="file-stage-text-more muted small">
          Showing the first {formatBytes(TEXT_PREVIEW_BYTES)} of {formatBytes(size)}.
          {size! <= TEXT_SHOW_ALL_BYTES
            ? <button className="link-btn" onClick={() => setAll(true)}>Show all</button>
            : ' Open the file to see all of it.'}
        </div>
      )}
    </div>
  );
}
