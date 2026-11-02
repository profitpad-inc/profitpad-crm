import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { uploadFile } from '../lib/files';

// Uploads files on their own, not into a record's file property (the Files
// list). Needs Create on files. Shows progress on the button itself.
export function FileUploadButton({ onUploaded, onError }: { onUploaded: (ids: string[]) => void; onError: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ index: number; count: number; fraction: number } | null>(null);

  async function upload(list: FileList | null) {
    if (!list || list.length === 0) return;
    const picked = [...list];
    const ids: string[] = [];
    try {
      for (const [index, f] of picked.entries()) {
        setProgress({ index, count: picked.length, fraction: 0 });
        ids.push(await uploadFile(f, null, (fraction) => setProgress({ index, count: picked.length, fraction })));
      }
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setProgress(null);
      if (input.current) input.current.value = '';
      if (ids.length > 0) onUploaded(ids);
    }
  }

  const label = progress
    ? `Uploading${progress.count > 1 ? ` ${progress.index + 1} of ${progress.count}` : ''}… ${Math.round(progress.fraction * 100)}%`
    : 'Upload files';
  return (
    <>
      <input ref={input} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
      <button className="btn primary" disabled={progress !== null} onClick={() => input.current?.click()}>
        <Upload size={16} /> {label}
      </button>
    </>
  );
}
