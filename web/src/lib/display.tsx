import {
  Box, Building2, CalendarClock, CalendarDays, CircleDollarSign, ClipboardList, Contact, CreditCard, File, FileText, Handshake, Home,
  ListChecks, Mail, MailPlus, Megaphone, Package, PhoneCall, ReceiptText, ShoppingBag, ShoppingCart, StickyNote, TextQuote,
  Ticket, User, Users, Wrench, Zap, BarChart3, LayoutDashboard, type LucideIcon
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { CrmRecord, Property } from './api';
import { ColorPill } from '../components/ColorPicker';

const OBJECT_ICONS: Record<string, LucideIcon> = {
  users: User,
  teams: Users,
  contacts: Contact,
  companies: Building2,
  deals: Handshake,
  tickets: Ticket,
  services: Wrench,
  lines: ReceiptText,
  products: Package,
  quotes: FileText,
  invoices: CircleDollarSign,
  payments: CreditCard,
  carts: ShoppingCart,
  orders: ShoppingBag,
  calls: PhoneCall,
  emails: Mail,
  notes: StickyNote,
  tasks: ListChecks,
  booking_pages: CalendarClock,
  files: File,
  email_templates: MailPlus,
  forms: ClipboardList,
  form_submissions: TextQuote,
  marketing_events: Megaphone,
  marketing_event_participations: CalendarDays,
  object_events: Zap,
  object_event_occurrences: Zap,
  views: LayoutDashboard
};

export function objectIcon(apiName: string): LucideIcon {
  return OBJECT_ICONS[apiName] ?? Box;
}

export const HomeIcon = Home;
export const ReportingIcon = BarChart3;

// Groups for the "More" menu.
export const MORE_GROUPS: { label: string; objects: string[] }[] = [
  { label: 'CRM', objects: ['contacts', 'companies', 'deals', 'tickets', 'products', 'orders', 'services', 'lines', 'quotes', 'invoices', 'payments', 'carts'] },
  { label: 'Activities', objects: ['calls', 'emails', 'notes', 'tasks', 'booking_pages'] },
  { label: 'Marketing', objects: ['forms', 'form_submissions', 'email_templates', 'marketing_events', 'marketing_event_participations'] },
  { label: 'Data', objects: ['users', 'teams', 'files', 'views', 'object_events', 'object_event_occurrences'] }
];

// The best human name for a record: name, else first + last, else email,
// domain or subject, else its id.
export function displayName(props: Record<string, unknown> | undefined, id: string): string {
  if (!props) return `#${id}`;
  const pick = (k: string) => (typeof props[k] === 'string' && (props[k] as string).trim() ? (props[k] as string).trim() : null);
  const full = [pick('first_name'), pick('last_name')].filter(Boolean).join(' ');
  return pick('name') ?? (full || null) ?? pick('email') ?? pick('domain') ?? pick('subject') ?? `#${id}`;
}

export function recordName(r: CrmRecord): string {
  return displayName(r.properties, r.id);
}

// Properties to request so displayName works for any object.
export const NAME_PROPERTIES = ['name', 'first_name', 'last_name', 'email', 'domain', 'subject'];

export function nameProperties(available: Property[]): string[] {
  const names = new Set(available.map((p) => p.api_name));
  return NAME_PROPERTIES.filter((n) => names.has(n));
}

export function valueType(p: Property): string {
  return p.type === 'calculation' ? p.calc_output_type ?? 'text' : p.type;
}

// Sort direction on first click: newest/largest first for numbers and dates.
export function defaultSortDirection(p: Property): 'asc' | 'desc' {
  const t = valueType(p);
  return t === 'number' || t === 'date' || t === 'datetime' ? 'desc' : 'asc';
}

const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function optionLabel(p: Property, value: string): string {
  return p.dropdown_options?.find((o) => o.api_value === value)?.label ?? value;
}

// Who made a change (created_by, updated_by): users by name (the API sends
// them as the property's options), anything else by what it was.
export function actorLabel(p: Property, value: string): string {
  const user = p.dropdown_options?.find((o) => o.api_value === value);
  if (user) return user.label;
  const [kind, rest] = [value.split(':')[0], value.slice(value.indexOf(':') + 1)];
  if (kind === 'user') return 'Removed user';
  if (kind === 'api') return `API key ${rest}`;
  if (kind === 'system') return rest === 'migration' ? 'System update' : rest === 'calculation' ? 'Calculation' : 'System';
  if (kind === 'public') return 'Public page';
  return value;
}

// Phone properties store +16132220328ext4 (the API checks them with Google's
// libphonenumber). Shown as +1 613-222-0328 ext4; other countries keep the
// stored digits, since grouping them needs the library's metadata.
export function displayPhone(v: string): string {
  const m = /^\+(\d+?)(?:ext(\d+))?$/.exec(v);
  if (!m) return v;
  const [, digits, ext] = m;
  const main = digits.length === 11 && digits.startsWith('1')
    ? `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`
    : `+${digits}`;
  return ext ? `${main} ext${ext}` : main;
}

export function formatValue(p: Property, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (p.type === 'text' && p.options.display === 'phone' && typeof value === 'string') return displayPhone(value);
  if (p.type === 'file' && Array.isArray(value)) return value.length === 1 ? '1 file' : `${value.length} files`;
  if (p.type === 'actor') return actorLabel(p, String(value));
  const t = valueType(p);
  if (p.type === 'dropdown') {
    const values = Array.isArray(value) ? value : [value];
    return values.map((v) => optionLabel(p, String(v))).join(', ');
  }
  if (t === 'number') {
    const n = Number(value);
    const decimals = typeof p.options.decimals === 'number' ? p.options.decimals : undefined;
    const format = p.options.format;
    let text: string;
    if (format === 'unformatted') text = String(n);
    else if (format === 'percentage') text = `${(n * 100).toLocaleString(undefined, { maximumFractionDigits: decimals ?? 2 })}%`;
    else if (format === 'currency') {
      const code = typeof p.options.currency_code === 'string' ? p.options.currency_code : 'USD';
      text = n.toLocaleString(undefined, { style: 'currency', currency: code, minimumFractionDigits: decimals, maximumFractionDigits: decimals ?? 2 });
    } else text = n.toLocaleString(undefined, { maximumFractionDigits: decimals ?? 6 });
    return `${p.options.prefix ?? ''}${text}${p.options.suffix ?? ''}`;
  }
  if (t === 'date') return dateFmt.format(new Date(`${value}T00:00:00Z`));
  if (t === 'datetime') return dateTimeFmt.format(new Date(String(value)));
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

// formatValue for showing on screen: dropdown choices with a colour get a
// large dot or a pill, as the property's color_display says ('' when empty,
// like formatValue).
export function displayValue(p: Property, value: unknown): ReactNode {
  const style = p.options.color_display;
  if (p.type !== 'dropdown' || (style !== 'dot' && style !== 'pill') || value === null || value === undefined || value === '') return formatValue(p, value);
  const values = (Array.isArray(value) ? value : [value]).map(String);
  const options = values.map((v) => p.dropdown_options?.find((o) => o.api_value === v));
  if (!options.some((o) => o?.color)) return formatValue(p, value);
  return (
    <span className="pill-list">
      {values.map((v, i) => {
        const o = options[i];
        if (!o?.color) return <span key={v}>{o?.label ?? v}</span>;
        return style === 'dot'
          ? <span key={v} className="color-dot-value"><span className="color-dot" style={{ background: o.color }} />{o.label}</span>
          : <ColorPill key={v} color={o.color}>{o.label}</ColorPill>;
      })}
    </span>
  );
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}
