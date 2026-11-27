import { StatusPill, type Tone } from './settings';
import '../email.css';

// What happened to an email Postmark sent, on the timeline: delivered, opened,
// clicked, replied, bounced (from Postmark's webhooks, api/src/email/events.ts).
// An email sent from a mailbox through the composer shows its opens and clicks
// (api/src/mailbox/tracking.ts); its sending state is shown elsewhere.

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v) as string | undefined;

export function EmailTracking({ p }: { p: Record<string, unknown> }) {
  if (first(p.direction) !== 'outbound') return null;
  const pills: [Tone, string][] = [];
  // sent from a mailbox through the composer: only opens and clicks here
  const stream = first(p.stream);
  if (!stream || stream === 'one_to_one') {
    if (stream !== 'one_to_one' && first(p.logged_via) !== 'composer') return null;
    if (p.first_opened_at) pills.push(['info', Number(p.open_count) > 1 ? `Opened ${Number(p.open_count)}×` : 'Opened']);
    if (p.first_clicked_at) pills.push(['info', Number(p.click_count) > 1 ? `Clicked ${Number(p.click_count)}×` : 'Clicked']);
    return pills.length ? <div className="email-track">{pills.map(([tone, label]) => <StatusPill key={label} tone={tone}>{label}</StatusPill>)}</div> : null;
  }
  const status = first(p.status);
  if (status === 'queued') pills.push(['pending', 'Sending']);
  if (status === 'failed') pills.push(['failed', 'Not sent']);
  if (status === 'bounced') pills.push(['failed', 'Bounced']);
  if (status === 'complained') pills.push(['failed', 'Marked as spam']);
  if (p.delivered_at && status !== 'bounced') pills.push(['on', 'Delivered']);
  if (p.first_opened_at) pills.push(['info', Number(p.open_count) > 1 ? `Opened ${Number(p.open_count)}×` : 'Opened']);
  if (p.first_clicked_at) pills.push(['info', Number(p.click_count) > 1 ? `Clicked ${Number(p.click_count)}×` : 'Clicked']);
  if (p.replied_at) pills.push(['on', 'Replied']);
  if (!pills.length) return null;
  return (
    <div className="email-track">
      {pills.map(([tone, label]) => <StatusPill key={label} tone={tone}>{label}</StatusPill>)}
    </div>
  );
}
