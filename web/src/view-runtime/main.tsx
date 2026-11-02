import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import * as Recharts from 'recharts';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import * as kit from './kit';
import { listen, post, report } from './bridge';
import './frame.css';

// The view frame: a sandboxed iframe (no same-origin) that runs one view's
// compiled module. Built into a single HTML file (vite.frame.config.ts) whose
// CSP allows only this inline script (by hash) plus eval for the module, and
// no network at all: data comes through the bridge.

const MODULES: Record<string, unknown> = { react: React, 'react/jsx-runtime': jsxRuntime, '@pcrm/view': kit, recharts: Recharts };

// what the view says about itself besides its component
interface Loaded {
  View: React.ComponentType;
  fill: boolean;
}

function load(code: string): Loaded {
  const module = { exports: {} as Record<string, unknown> };
  const require = (name: string) => {
    if (!(name in MODULES)) throw new Error(`views cannot import "${name}"`);
    return MODULES[name];
  };
  new Function('require', 'exports', 'module', code)(require, module.exports, module);
  const view = module.exports.default;
  if (typeof view !== 'function') throw new Error('the view has no default export');
  return { View: view as React.ComponentType, fill: module.exports.frame === 'fill' };
}

// Errors the viewer would otherwise only see in the browser console are
// reported to the page (and logged for the view's builder).
const errorText = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : (() => { try { return JSON.stringify(e); } catch { return String(e); } })());
window.addEventListener('error', (e) => report('error', e.message || errorText(e.error), e.error instanceof Error ? e.error.stack : undefined));
window.addEventListener('unhandledrejection', (e) => report('error', `Unhandled promise rejection: ${errorText(e.reason)}`, e.reason instanceof Error ? e.reason.stack : undefined));
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  consoleError(...args);
  const first = args[0];
  // React's own note after a caught render error repeats the crash report
  if (typeof first === 'string' && /The above error occurred/.test(first)) return;
  report('console', args.map(errorText).join(' ').slice(0, 2000), args.find((a): a is Error => a instanceof Error)?.stack);
};

listen((msg) => {
  for (const [k, v] of Object.entries(msg.theme ?? {})) document.documentElement.style.setProperty(k, v);
  const el = document.getElementById('root')!;
  try {
    const { View, fill } = load(msg.module);
    if (fill) document.documentElement.classList.add('v-fill');
    post({ type: 'pcrm:mode', fill });
    createRoot(el).render(
      <kit.ErrorBoundary>
        <View />
      </kit.ErrorBoundary>
    );
  } catch (err) {
    post({ type: 'pcrm:error', message: (err as Error).message });
    report('start', (err as Error).message, (err as Error).stack);
    createRoot(el).render(<div className="v-page"><kit.ErrorBox error={`This view could not start: ${(err as Error).message}`} /></div>);
  }
});

// the page sizes the iframe to its content, so the CRM page scrolls, not the
// frame (fill views scroll themselves and the page ignores this)
new ResizeObserver(() => post({ type: 'pcrm:height', height: Math.ceil(document.documentElement.scrollHeight) })).observe(document.body);
post({ type: 'pcrm:ready' });
