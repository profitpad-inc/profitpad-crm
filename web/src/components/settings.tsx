import { useState, type FormEvent, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';

// Building blocks shared by every Settings page (styles in settings.css). A page is a header (title, description,
// main action top right) and a body of sections; settings themselves are label/control rows, lists are framed
// tables, and cards are kept for things (an endpoint, a calendar, a form being filled in).

export function SettingsPage({ title, description, actions, children, className }: {
  title: string; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string;
}) {
  return (
    <section className={`settings-page${className ? ` ${className}` : ''}`}>
      <header className="settings-head">
        <div className="settings-head-text">
          <h1>{title}</h1>
          {description && <p className="settings-desc">{description}</p>}
        </div>
        {actions && <div className="settings-head-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function SettingsSection({ title, description, actions, children, className }: {
  title?: string; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string;
}) {
  return (
    <div className={`settings-section${className ? ` ${className}` : ''}`}>
      {(title || actions) && (
        <div className="settings-section-head">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p className="settings-section-desc">{description}</p>}
          </div>
          {actions && <div className="settings-head-actions">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

// One setting: what it is on the left, the control on the right (stacked on narrow screens).
export function SettingRow({ label, hint, children, htmlFor }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; htmlFor?: string }) {
  return (
    <div className="setting-row">
      <div className="setting-row-label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {hint && <p>{hint}</p>}
      </div>
      <div className="setting-row-control">{children}</div>
    </div>
  );
}

// A form being filled in, inline on the page. The footer holds Cancel then the main action.
export function EditPanel({ title, onSubmit, footer, children, className }: {
  title?: string; onSubmit?: () => void; footer?: ReactNode; children?: ReactNode; className?: string;
}) {
  const body = (
    <>
      {title && <div className="edit-panel-head">{title}</div>}
      <div className="edit-panel-body">{children}</div>
      {footer && <div className="edit-panel-foot">{footer}</div>}
    </>
  );
  const cls = `edit-panel${className ? ` ${className}` : ''}`;
  if (!onSubmit) return <div className={cls}>{body}</div>;
  return <form className={cls} onSubmit={(e: FormEvent) => { e.preventDefault(); onSubmit(); }}>{body}</form>;
}

// compact: a one-line version for a section inside a page that already says what it is for
export function EmptyState({ icon, title, children, action, compact }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; compact?: boolean }) {
  if (compact) {
    return (
      <div className="empty-state compact">
        {icon && <span className="empty-state-icon" aria-hidden>{icon}</span>}
        <p><strong>{title}.</strong> {children}</p>
        {action}
      </div>
    );
  }
  return (
    <div className="empty-state">
      {icon && <span className="empty-state-icon" aria-hidden>{icon}</span>}
      <div className="empty-state-title">{title}</div>
      {children && <p>{children}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}

export function TableSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="table-skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <span key={i} />)}
    </div>
  );
}

export type Tone = 'on' | 'off' | 'failed' | 'pending' | 'warn' | 'info';

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

// Sticky bar at the bottom of pages whose one Save covers several sections.
export function SaveBar({ dirty, message, error, children }: { dirty?: boolean; message?: string | null; error?: string | null; children: ReactNode }) {
  return (
    <div className={`save-bar${dirty ? ' dirty' : ''}`}>
      <span className={`save-bar-note${error ? ' failed' : ''}`} role="status">
        {error ?? (dirty ? 'You have unsaved changes.' : message ?? '')}
      </span>
      <div className="save-bar-actions">{children}</div>
    </div>
  );
}

// A value to copy (an address, a secret shown once).
export function CopyField({ value, label, secret }: { value: string; label: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`copy-field${secret ? ' secret' : ''}`}>
      <code aria-label={label}>{value}</code>
      <button type="button" className="btn small" onClick={() => {
        navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined);
      }}>
        {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
