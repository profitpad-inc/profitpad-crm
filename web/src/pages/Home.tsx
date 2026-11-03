import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
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
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <>
      {mobile && <MobileHeader />}
      <div className="page home">
        <header className="home-head">
          <div className="home-date">{today}</div>
          <h1 className="page-title">{first ? `Welcome back, ${first}` : 'Welcome'}</h1>
          {!mobile && <p className="muted">Press <kbd>{mac ? '⌘' : 'Ctrl'}</kbd> <kbd>K</kbd> to search every record.</p>}
        </header>
        {!me.is_admin && me.readable_objects.length === 0 && (
          <div className="callout">You don’t have access to anything yet. Ask an admin to give you a role.</div>
        )}
        {objects.length > 0 && (
          <section className="home-section">
            <h2>Your objects</h2>
            <div className="object-list">
              {objects.map((o) => {
                const Icon = objectIcon(o);
                return (
                  <Link key={o} to={`/objects/${o}`} className="object-row">
                    <span className="object-row-icon"><Icon size={18} strokeWidth={1.75} /></span>
                    <span className="object-row-label">{objectByName.get(o)?.label_plural}</span>
                    <span className="object-row-count">{counts[o]?.toLocaleString() ?? ''}</span>
                    <ChevronRight size={16} className="object-row-go" />
                  </Link>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
