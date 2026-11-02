import { useEffect, useRef, useState } from 'react';
import { Download, Paperclip, Upload, X } from 'lucide-react';
import { api, type CrmRecord, type Property } from '../lib/api';
import { useApp } from '../lib/app-context';
import { fileInfo, formatBytes, openFile, uploadFile, type FileInfo } from '../lib/files';

// A file property on a record page: the attached files (open, download,
// remove) and an Upload button. New files upload first, then the property is
// saved with them added, like any other property change.
export function FileField({ object, record, property, canEdit, onSaved }: {
  object: string; record: CrmRecord; property: Property; canEdit: boolean; onSaved: (r: CrmRecord) => void;
}) {
  const { toast } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const ids = Array.isArray(record.properties[property.api_name]) ? (record.properties[property.api_name] as string[]) : [];
  const [files, setFiles] = useState<FileInfo[] | null>(null);
  const [progress, setProgress] = useState<{ name: string; fraction: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const max = typeof property.options.max_files === 'number' ? property.options.max_files : null;
  const room = max === null ? Infinity : max - ids.length;
  const key = ids.join(',');

  useEffect(() => {
    let live = true;
    fileInfo(ids).then((f) => live && setFiles(f), () => live && setFiles([]));
    return () => {
      live = false;
    };
  }, [key]);

  async function save(next: string[]) {
    onSaved(await api<CrmRecord>('PATCH', `/v1/objects/${object}/${record.id}`, { properties: { [property.api_name]: next.length ? next : null } }));
  }

  async function add(list: FileList | null) {
    if (!list || list.length === 0) return;
    setError(null);
    const picked = [...list];
    if (picked.length > room) {
      setError(`${property.label} holds at most ${max} ${max === 1 ? 'file' : 'files'}.`);
      return;
    }
    const added: string[] = [];
    try {
      for (const f of picked) {
        setProgress({ name: f.name, fraction: 0 });
        added.push(await uploadFile(f, { object, record_id: record.id, property: property.api_name }, (fraction) => setProgress({ name: f.name, fraction })));
      }
      await save([...ids, ...added]);
      toast(added.length === 1 ? 'File added' : `${added.length} files added`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await save(ids.filter((i) => i !== id));
      toast('File removed');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const open = (id: string, download = false) => openFile(id, download).catch((err) => setError((err as Error).message));
  const hiddenCount = files ? ids.length - files.length : 0;

  return (
    <div className="file-field" onClick={(e) => e.stopPropagation()}>
      {files?.map((f) => (
        <div key={f.id} className="file-row">
          <Paperclip size={14} strokeWidth={1.75} />
          <button className="link-btn file-name" title={f.name ?? ''} onClick={() => open(f.id)} disabled={f.status !== 'ready'}>{f.name}</button>
          <span className="muted small">{f.status === 'ready' ? formatBytes(f.size_bytes) : 'uploading'}</span>
          {f.status === 'ready' && (
            <button className="icon-btn faint-btn" aria-label={`Download ${f.name}`} title="Download" onClick={() => open(f.id, true)}><Download size={14} /></button>
          )}
          {canEdit && (
            <button className="icon-btn faint-btn" aria-label={`Remove ${f.name}`} title="Remove" onClick={() => remove(f.id)}><X size={14} /></button>
          )}
        </div>
      ))}
      {hiddenCount > 0 && <div className="muted small">{hiddenCount === 1 ? '1 file you cannot open' : `${hiddenCount} files you cannot open`}</div>}
      {files && ids.length === 0 && !progress && <span className="muted empty-value">--</span>}
      {progress && (
        <div className="file-progress" role="status">
          <span className="small">{progress.name}</span>
          <progress max={1} value={progress.fraction} />
          <span className="muted small">{Math.round(progress.fraction * 100)}%</span>
        </div>
      )}
      {canEdit && room > 0 && !progress && (
        <>
          <input ref={input} type="file" multiple={room > 1} hidden onChange={(e) => add(e.target.files)} />
          <button className="btn small file-upload-btn" onClick={() => input.current?.click()}><Upload size={14} /> Upload</button>
        </>
      )}
      {error && <div className="error prop-error" role="alert">{error}</div>}
    </div>
  );
}
