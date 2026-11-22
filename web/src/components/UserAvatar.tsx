import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { initials } from '../lib/display';

// Profile photos (api/src/user-photos.ts): one map of user id to photo link,
// loaded once and shared by every avatar on the page. refreshUserPhotos()
// reloads it after someone changes their photo. Users without a photo, or
// whose photo fails to load, show their initials.

type PhotoMap = Record<string, string>;
let photos: PhotoMap | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<(m: PhotoMap) => void>();

function load(): Promise<void> {
  loading ??= api<{ photos: PhotoMap }>('GET', '/v1/users/photos')
    .then((r) => { photos = r.photos; })
    .catch(() => { photos = photos ?? {}; })
    .then(() => { loading = null; listeners.forEach((l) => l(photos!)); });
  return loading;
}

export function refreshUserPhotos(): Promise<void> {
  return load();
}

export function useUserPhotos(): PhotoMap {
  const [map, setMap] = useState<PhotoMap>(photos ?? {});
  useEffect(() => {
    listeners.add(setMap);
    if (photos) setMap(photos);
    else void load();
    return () => { listeners.delete(setMap); };
  }, []);
  return map;
}

// className is the existing avatar style of the place it sits in (avatar,
// person-avatar, comment-avatar, ...); the photo fills that circle.
export function UserAvatar({ userId, name, className, src }: { userId?: string | null; name: string; className: string; src?: string | null }) {
  const map = useUserPhotos();
  const url = src !== undefined ? src : userId ? map[userId] : undefined;
  const [failed, setFailed] = useState<string | null>(null);
  if (url && failed !== url) {
    return (
      <span className={`${className} has-photo`} aria-hidden>
        <img src={url} alt="" onError={() => setFailed(url)} />
      </span>
    );
  }
  return <span className={className} aria-hidden>{initials(name)}</span>;
}
