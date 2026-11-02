import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import * as Recharts from 'recharts';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import * as kit from './kit';
import { listen, post } from './bridge';
import './frame.css';

// The view frame: a sandboxed iframe (no same-origin) that runs one view's
// compiled module. Built into a single HTML file (vite.frame.config.ts) whose
// CSP allows only this inline script (by hash) plus eval for the module, and
// no network at all: data comes through the bridge.

const MODULES: Record<string, unknown> = { react: React, 'react/jsx-runtime': jsxRuntime, '@pcrm/view': kit, recharts: Recharts };

function load(code: string): React.ComponentType {
  const module = { exports: {} as Record<string, unknown> };
  const require = (name: string) => {
    if (!(name in MODULES)) throw new Error(`views cannot import "${name}"`);
    return MODULES[name];
  };
  new Function('require', 'exports', 'module', code)(require, module.exports, module);
  const view = module.exports.default;
  if (typeof view !== 'function') throw new Error('the view has no default export');
  return view as React.ComponentType;
}

listen((msg) => {
  for (const [k, v] of Object.entries(msg.theme ?? {})) document.documentElement.style.setProperty(k, v);
  const el = document.getElementById('root')!;
  try {
    const View = load(msg.module);
    createRoot(el).render(
      <kit.ErrorBoundary>
        <View />
      </kit.ErrorBoundary>
    );
  } catch (err) {
    post({ type: 'pcrm:error', message: (err as Error).message });
    createRoot(el).render(<div className="v-page"><kit.ErrorBox error={`This view could not start: ${(err as Error).message}`} /></div>);
  }
});

// the page sizes the iframe to its content, so the CRM page scrolls, not the frame
new ResizeObserver(() => post({ type: 'pcrm:height', height: Math.ceil(document.documentElement.scrollHeight) })).observe(document.body);
post({ type: 'pcrm:ready' });
