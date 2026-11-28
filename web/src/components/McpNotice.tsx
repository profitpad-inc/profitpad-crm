import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { Modal } from './ui';
import { CopyField } from './settings';
import { MCP_URL } from '../pages/ConnectedApps';

// The one-line "build this with AI" note on things made through the MCP
// rather than a UI builder (landing pages, views, email and document
// templates), with a popup on what an MCP is, how to connect one and why
// there is no builder.

export type McpKind = 'landing_pages' | 'views' | 'email_templates' | 'document_templates';

const NOUN: Record<McpKind, string> = {
  landing_pages: 'landing pages',
  views: 'views',
  email_templates: 'email templates',
  document_templates: 'document templates'
};

const EXAMPLE: Record<McpKind, string> = {
  landing_pages: 'Build a landing page for our spring webinar with a sign-up form, our logo and a dark hero section.',
  views: 'Make a view that shows this month\'s open deals by owner, with a chart on top and a table below.',
  email_templates: 'Write an email template welcoming new customers, with our colors, a big button to book onboarding and the contact\'s first name.',
  document_templates: 'Make our quote template look like our letterhead, with the line items in a striped table and a signature block at the bottom.'
};

export function McpNotice({ kind, className }: { kind: McpKind; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className={`mcp-notice${className ? ` ${className}` : ''}`}>
        <Sparkles size={14} aria-hidden />
        <span>
          We recommend building and changing {NOUN[kind]} by asking your AI through the CRM's MCP connection.{' '}
          <button type="button" className="link-btn" onClick={() => setOpen(true)}>What's that?</button>
        </span>
      </p>
      {open && <McpExplainer kind={kind} onClose={() => setOpen(false)} />}
    </>
  );
}

function McpExplainer({ kind, onClose }: { kind: McpKind; onClose: () => void }) {
  return (
    <Modal title="Build it with AI" onClose={onClose} className="mcp-explainer" footer={<button className="btn primary" onClick={onClose}>Got it</button>}>
      <section>
        <h3>What is an MCP?</h3>
        <p>
          MCP (Model Context Protocol) is an open standard that lets an AI assistant, such as Claude, use other apps.
          The CRM runs an MCP server, so once you connect it, your AI can read and change the CRM for you.
          It works as you: it sees and changes only what you can, with the access you allow.
        </p>
      </section>
      <section>
        <h3>How to connect it</h3>
        <ol>
          <li>Copy the CRM's MCP server address:</li>
        </ol>
        <CopyField value={MCP_URL} label="MCP server address" />
        <ol start={2}>
          <li>In your AI app, add it as a connector (some apps call it a custom connector or an MCP server).</li>
          <li>Sign in to the CRM when it asks, and allow access.</li>
          <li>Ask for what you want in plain English. For example: <em>"{EXAMPLE[kind]}"</em></li>
        </ol>
        <p className="muted small">
          You can see and disconnect your connected apps in <Link to="/settings/connected-apps" onClick={onClose}>Settings, Connected apps</Link>.
        </p>
      </section>
      <section>
        <h3>Why we built it this way</h3>
        <ul>
          <li>Instead of a drag-and-drop builder for templates, pages and views, you build them with AI.</li>
          <li>Builders are clunky, annoying to use and restrictive, and they only do what their buttons allow.</li>
          <li>With the MCP you get unlimited customization in any style you want, and you just say what you want in plain English.</li>
        </ul>
        <p className="muted small">You can still read the code, preview drafts and publish here in the CRM.</p>
      </section>
    </Modal>
  );
}
