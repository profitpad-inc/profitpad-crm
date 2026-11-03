import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Principal } from './auth.js';
import { approvalChange, canApprove, type ApprovalRow } from './approval.js';

const admin = (extra: Partial<Principal>): Principal => ({
  keyId: null, name: 'x', scopes: new Set(['read', 'write', 'admin']), userId: '0000000009', actor: 'user:0000000009', permissions: null, ...extra
});
const session = admin({ session: { id: '1', signedInAt: new Date() } });
const staleSession = admin({ session: { id: '1', signedInAt: new Date(Date.now() - 30 * 24 * 3600_000) } });
const mcp = admin({
  scopes: new Set(['read', 'write', 'schema']),
  oauth: { clientId: 'c', clientName: 'Claude', grantId: 1, expiresAt: new Date(Date.now() + 3600_000) }
});
const apiKey = admin({ keyId: 7, actor: 'api:abcd1234', userId: null });

const row = (r: Partial<ApprovalRow>): ApprovalRow => ({
  enabled: true, awaiting_approval: false, requested_by: null, requested_via: null, requested_at: null, approved_by: null, approved_at: null, ...r
});

test('only an admin signed in to the CRM can approve', () => {
  assert.equal(canApprove(session), true);
  assert.equal(canApprove(mcp), false);
  assert.equal(canApprove(apiKey), false);
  // a user without an admin role: no admin scope, and their role permissions
  assert.equal(canApprove(admin({ session: { id: '1', signedInAt: new Date() }, scopes: new Set(['read', 'write']), permissions: { objects: new Map() } as never })), false);
});

test('created over MCP or with an API key it starts off, whatever enabled says', () => {
  for (const p of [mcp, apiKey]) {
    for (const enabled of [undefined, true, false]) {
      const out = approvalChange(p, 'It', 'u', enabled, true);
      assert.equal(out.enabled, false);
      assert.equal(out.awaiting_approval, true);
      assert.equal(out.requested_by, p.actor);
    }
  }
  assert.equal(approvalChange(mcp, 'It', 'u', undefined, true).requested_via, 'Claude');
  assert.equal(approvalChange(apiKey, 'It', 'u', undefined, true).requested_via, 'API key');
});

test('created by an admin in the CRM it is on and approved', () => {
  const out = approvalChange(session, 'It', 'u', undefined, true);
  assert.equal(out.enabled, true);
  assert.equal(out.awaiting_approval, false);
  assert.equal(out.approved_by, session.actor);
  assert.deepEqual(approvalChange(session, 'It', 'u', false, true), { enabled: false });
});

test('MCP cannot turn one on', () => {
  assert.throws(() => approvalChange(mcp, 'It', 'https://crm/settings/x?review=k', true, false, row({ enabled: false, awaiting_approval: true })),
    (err: { code: string; details: { approve_url: string } }) => err.code === 'approval_required' && err.details.approve_url === 'https://crm/settings/x?review=k');
  assert.throws(() => approvalChange(mcp, 'It', 'u', true, false, row({ enabled: false })), { code: 'approval_required' } as never);
  // asking for what it already is changes nothing
  assert.deepEqual(approvalChange(mcp, 'It', 'u', true, false, row({})), {});
});

test('MCP may turn one off, and harmless edits leave it as it is', () => {
  assert.deepEqual(approvalChange(mcp, 'It', 'u', false, false, row({})), { enabled: false });
  assert.deepEqual(approvalChange(mcp, 'It', 'u', undefined, false, row({})), {});
});

test('MCP changing where data goes turns it off until approved again', () => {
  const out = approvalChange(mcp, 'It', 'u', undefined, true, row({}));
  assert.equal(out.enabled, false);
  assert.equal(out.awaiting_approval, true);
  assert.throws(() => approvalChange(mcp, 'It', 'u', true, true, row({})), { code: 'approval_required' } as never);
});

test('an admin in the CRM approves by turning it on, with a recent sign-in', () => {
  const out = approvalChange(session, 'It', 'u', true, false, row({ enabled: false, awaiting_approval: true }));
  assert.equal(out.enabled, true);
  assert.equal(out.awaiting_approval, false);
  assert.equal(out.approved_by, session.actor);
  assert.throws(() => approvalChange(staleSession, 'It', 'u', true, false, row({ enabled: false, awaiting_approval: true })), { code: 'reauth_required' } as never);
  // an admin's own edits need no new approval
  assert.deepEqual(approvalChange(session, 'It', 'u', undefined, true, row({})), {});
});
