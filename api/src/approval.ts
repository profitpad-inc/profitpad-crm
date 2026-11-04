import { ApiError } from './errors.js';
import { requireRecentSignIn, type Principal } from './auth.js';

// Admin approval (migration 0061) for places CRM data goes: view
// integrations, webhook endpoints and subscriptions, and embed domains.
// Anyone who may manage them (an admin's AI over MCP, an admin API key) can
// set them up, but only an admin signed in to the CRM in a browser can turn
// one on. Set up from outside the CRM, they start off and wait; changing
// where an enabled one sends data, or what it sends, turns it off again.

const uiBase = (process.env.UI_URL ?? '').replace(/\/$/, '');

// An admin's browser session, not a connected app or an API key.
export function canApprove(p: Principal): boolean {
  return !!p.session && !p.oauth && p.keyId === null && (p.scopes.has('admin') || (p.userId !== null && p.permissions === null));
}

// Where the admin approves it: a Settings page, opened on the item.
export const approveUrl = (page: string, review: string | number) => `${uiBase}/settings/${page}?review=${encodeURIComponent(String(review))}`;

// What the row records about who asked.
export function requestFields(p: Principal): { awaiting_approval: true; requested_by: string; requested_via: string | null; requested_at: Date } {
  return {
    awaiting_approval: true,
    requested_by: p.actor,
    requested_via: p.oauth?.clientName ?? (p.keyId !== null ? 'API key' : null),
    requested_at: new Date()
  };
}

// An admin turning one on: needs a recent sign-in, like other admin changes.
export function approveFields(p: Principal): { awaiting_approval: false; approved_by: string; approved_at: Date } {
  requireRecentSignIn(p);
  return { awaiting_approval: false, approved_by: p.actor, approved_at: new Date() };
}

export function approvalRequired(what: string, url: string): ApiError {
  return new ApiError(403, `${what} can only be turned on by an admin signed in to the CRM. Give the admin this link to review and turn it on: ${url}`, 'approval_required', { approve_url: url });
}

export interface ApprovalRow {
  enabled: boolean;
  awaiting_approval: boolean;
  requested_by: string | null;
  requested_via: string | null;
  requested_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
}

// While it waits, approved_by and approved_at are null so nobody reads it as
// approved; an earlier approval (before a change turned it off) shows as
// previous_approval.
export const approvalOut = (r: ApprovalRow, url: string) => ({
  awaiting_approval: r.awaiting_approval,
  requested_by: r.requested_by,
  requested_via: r.requested_via,
  requested_at: r.requested_at,
  approved_by: r.awaiting_approval ? null : r.approved_by,
  approved_at: r.awaiting_approval ? null : r.approved_at,
  ...(r.awaiting_approval && r.approved_at ? { previous_approval: { by: r.approved_by, at: r.approved_at } } : {}),
  ...(r.awaiting_approval ? { approve_url: url } : {})
});

// Why the answer is off when the caller may not have expected it, for
// approvalChange's callers to return as notice:
//   enabled: what the caller asked for; changed: the guarded fields that
//   changed (url, send_properties...); current: the row before an update
export function approvalNotice(p: Principal, enabled: boolean | undefined, changed: string[], current?: ApprovalRow): string | undefined {
  if (canApprove(p)) return undefined;
  if (!current) {
    return enabled === true
      ? 'enabled: true was not applied: set up from outside the CRM, it starts off until an admin signed in to the CRM turns it on (approve_url).'
      : 'It starts off until an admin signed in to the CRM turns it on (approve_url).';
  }
  if (changed.length && enabled !== false && current.enabled && !current.awaiting_approval) {
    return `Turned off because ${changed.join(', ')} changed: an admin has to approve it again (approve_url).`;
  }
  return undefined;
}

// The MCP's next step for anything waiting for approval
export function approvalNextStep(out: { awaiting_approval?: boolean; approve_url?: string; notice?: string }): { next_step?: string } {
  if (!out.awaiting_approval || !out.approve_url) return {};
  return { next_step: `${out.notice ? `${out.notice} ` : ''}Waiting for approval: give the admin this link to review and turn it on: ${out.approve_url}` };
}

// The enabled and approval columns for a create or an update.
//   enabled: what the caller asked for (undefined: not given)
//   guarded: whether the change touches where data goes or what is sent
//   current: the row before an update (undefined when creating)
// Created by someone who cannot approve, it starts off whatever enabled says;
// an update from them that asks to turn it on throws.
export function approvalChange(p: Principal, what: string, url: string, enabled: boolean | undefined, guarded: boolean, current?: ApprovalRow): Record<string, unknown> {
  if (canApprove(p)) {
    if (!current) return { enabled: enabled ?? true, ...(enabled === false ? {} : approveFields(p)) };
    if (enabled === undefined) return {};
    return enabled && (!current.enabled || current.awaiting_approval) ? { enabled: true, ...approveFields(p) } : { enabled };
  }
  if (!current) return { enabled: false, ...requestFields(p) };
  if (enabled === false) return guarded ? { enabled: false, ...requestFields(p) } : { enabled: false };
  if (enabled === true && (!current.enabled || guarded)) throw approvalRequired(what, url);
  return guarded ? { enabled: false, ...requestFields(p) } : {};
}
