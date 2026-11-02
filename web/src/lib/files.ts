import { API_BASE, ApiError, api } from './api';

// Files stored by the API (api/src/files.ts): uploads go up in chunks so a
// large video survives a dropped connection; files open through signed links.

export interface FileInfo {
  id: string;
  name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  status: 'uploading' | 'ready' | null;
  checksum: string | null;
  public_url: string | null;
  row_status: string;
  created_at: string;
}

export interface UploadTarget {
  object: string;
  record_id: string;
  property: string;
}

async function putChunk(id: string, offset: number, chunk: Blob): Promise<{ received: number }> {
  const res = await fetch(`${API_BASE}/v1/files/${id}/content?offset=${offset}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/octet-stream' },
    body: chunk
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.message ?? res.statusText, data?.error, data?.details);
  return data;
}

// Uploads a file and returns its id once it is ready. Each chunk is retried a
// few times; after a refusal the upload carries on from where the API says
// it stands.
export async function uploadFile(file: File, target: UploadTarget | null, onProgress?: (fraction: number) => void): Promise<string> {
  const start = await api<FileInfo & { chunk_bytes: number }>('POST', '/v1/files/uploads', {
    name: file.name,
    size: file.size,
    content_type: file.type || undefined,
    ...target
  });
  let offset = 0;
  let failures = 0;
  onProgress?.(file.size === 0 ? 1 : 0);
  while (offset < file.size) {
    try {
      const { received } = await putChunk(start.id, offset, file.slice(offset, offset + start.chunk_bytes));
      offset = received;
      failures = 0;
      onProgress?.(offset / file.size);
    } catch (err) {
      if (++failures > 3 || (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 409)) throw err;
      await new Promise((r) => setTimeout(r, 1000 * failures));
      const state = await api<{ received: number }>('GET', `/v1/files/${start.id}/upload`);
      offset = state.received;
    }
  }
  return start.id;
}

export async function fileInfo(ids: string[]): Promise<FileInfo[]> {
  if (ids.length === 0) return [];
  return (await api<{ results: FileInfo[] }>('GET', `/v1/files?ids=${ids.join(',')}`)).results;
}

export async function fileLink(id: string, download = false): Promise<string> {
  return (await api<{ url: string }>('GET', `/v1/files/${id}/url${download ? '?download=1' : ''}`)).url;
}

// Opens a file in a new tab. The tab is opened before the link is fetched,
// so pop-up blockers treat it as part of the click.
export async function openFile(id: string, download = false): Promise<void> {
  const tab = download ? null : window.open('', '_blank');
  try {
    const url = await fileLink(id, download);
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.location.href = url;
    }
  } catch (err) {
    tab?.close();
    throw err;
  }
}

export function formatBytes(n: number | null): string {
  if (n === null) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(undefined, { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}
