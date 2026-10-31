import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type SearchResult } from '../lib/api';
import { useApp } from '../lib/app-context';
import { objectIcon } from '../lib/display';
import { useIsMobile } from '../lib/use-mobile';
import { MobileHeader } from '../components/MobileNav';

// Placeholder home: record counts for the objects in the user's menu.
export function Home() {
  const { me, nav, objectByName } = useApp();
  const objects = [...new Set(nav.flatMap((i) => (i.type === 'section' ? i.items : [i])).filter((i) => i.type === 'object').map((i) => (i as { object: string }).object))]
    .filter((o) => objectByName.has(o));
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    objects.forEach((o) =>
      api<SearchResult>('POST', `/v1/objects/${o}/search`, { limit: 1, properties: ['name'] })
        .then((r) => setCounts((c) => ({ ...c, [o]: r.total })))
        .catch(() => undefined)
    );
  }, [objects.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const first = me.user?.first_name || me.user?.name?.split(' ')[0];
  const mobile = useIsMobile();
  return (
    <>
      {mobile && <MobileHeader />}
      <div className="page">
        <h1 className="page-title">{first ? `Welcome back, ${first}` : 'Welcome'}</h1>
        <div className="tiles">
          {objects.map((o) => {
            const Icon = objectIcon(o);
            return (
              <Link key={o} to={`/objects/${o}`} className="tile">
                <Icon size={20} strokeWidth={1.75} />
                <div className="tile-count">{counts[o]?.toLocaleString() ?? '…'}</div>
                <div className="muted">{objectByName.get(o)?.label_plural}</div>
              </Link>
            );
          })}
        </div>
      </div>
    </>
  );
}
