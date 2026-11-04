import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import 'flatpickr/dist/flatpickr.min.css'; // before styles.css, which overrides it
import './styles.css';
import './kit.css';
import { api, type Me } from './lib/api';
import { finishReauth, onReauthChange, reauthPending } from './lib/reauth';
import { AppProvider } from './lib/app-context';
import { installTooltips } from './lib/tooltips';
import { Sidebar } from './components/Sidebar';
import { BottomBar } from './components/MobileNav';
import { useIsMobile } from './lib/use-mobile';
import { Login } from './pages/Login';
import { Home } from './pages/Home';
import { ObjectTable } from './pages/ObjectTable';
import { RecordPage } from './pages/RecordPage';
import { Settings } from './pages/Settings';
import { CustomView } from './pages/CustomView';
import { CardScanner } from './pages/CardScanner';
import { SignedInAsBanner } from './components/SignedInAsBanner';

// Desktop: sidebar rail on the left. Phone: bottom bar, with the full menu
// in a hamburger drawer on the home page.
// A Super Admin signed in as another user sees a banner above the page
// (beside the sidebar) that cannot be closed.
function Layout() {
  const mobile = useIsMobile();
  return (
    <div className={`app${mobile ? ' mobile' : ''}`}>
      {!mobile && <Sidebar />}
      <div className="main-col">
        <SignedInAsBanner />
        <main className="main">
          <Outlet />
        </main>
      </div>
      {mobile && <BottomBar />}
    </div>
  );
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);

  // signed in through a session cookie; 401 shows the login page
  const load = useCallback(async () => {
    try {
      setMe(await api<Me>('GET', '/v1/me'));
    } catch {
      setMe(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const [reauth, setReauth] = useState(reauthPending);
  useEffect(() => onReauthChange(() => setReauth(reauthPending())), []);

  if (checking) return <div className="splash">Loading…</div>;
  if (!me) return <Login onSignedIn={(m) => m && setMe(m)} />;
  return (
    <AppProvider me={me} onSignOut={() => setMe(null)}>
      {reauth && <Login reauth onSignedIn={() => finishReauth(true)} onCancel={() => finishReauth(false)} />}
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="objects/:object" element={<ObjectTable />} />
          <Route path="objects/:object/:id" element={<RecordPage />} />
          <Route path="view" element={<CustomView />} />
          <Route path="scan" element={<CardScanner />} />
          {/* the old mock dashboard became the Reporting custom view */}
          <Route path="reporting" element={<Navigate to="/view/#reporting" replace />} />
          <Route path="settings/*" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </AppProvider>
  );
}

installTooltips();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
