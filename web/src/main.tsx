import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/montserrat/600.css';
import '@fontsource/montserrat/700.css';
import './styles.css';
import { api, getApiKey, type Me } from './lib/api';
import { AppProvider } from './lib/app-context';
import { Sidebar } from './components/Sidebar';
import { BottomBar } from './components/MobileNav';
import { useIsMobile } from './lib/use-mobile';
import { Login } from './pages/Login';
import { Home } from './pages/Home';
import { ObjectTable } from './pages/ObjectTable';
import { RecordPage } from './pages/RecordPage';
import { Settings } from './pages/Settings';
import { Reporting } from './pages/Reporting';

// Desktop: sidebar rail on the left. Phone: bottom bar, with the full menu
// in a hamburger drawer on the home page.
function Layout() {
  const mobile = useIsMobile();
  return (
    <div className={`app${mobile ? ' mobile' : ''}`}>
      {!mobile && <Sidebar />}
      <main className="main">
        <Outlet />
      </main>
      {mobile && <BottomBar />}
    </div>
  );
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);

  const load = useCallback(async () => {
    if (!getApiKey()) {
      setMe(null);
      setChecking(false);
      return;
    }
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

  if (checking) return <div className="splash">Loading…</div>;
  if (!me) return <Login onSignedIn={(m) => setMe(m)} />;
  return (
    <AppProvider me={me} onSignOut={() => setMe(null)}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="objects/:object" element={<ObjectTable />} />
          <Route path="objects/:object/:id" element={<RecordPage />} />
          <Route path="reporting" element={<Reporting />} />
          <Route path="settings/*" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </AppProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
