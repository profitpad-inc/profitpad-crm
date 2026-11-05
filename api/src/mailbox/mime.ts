import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { OutgoingMessage } from './providers.js';

// The whole RFC 5322 message Gmail sends (raw). nodemailer only builds it
// (headers with non-ASCII text, HTML and text parts, attachments); nothing
// here talks SMTP. Bcc stays in the headers: Gmail reads it for delivery and
// takes it out of what recipients get.
export function buildMime(msg: OutgoingMessage): Promise<Buffer> {
  const composer = new MailComposer({
    from: msg.from.name ? { name: msg.from.name, address: msg.from.address } : msg.from.address,
    to: msg.to,
    cc: msg.cc.length ? msg.cc : undefined,
    bcc: msg.bcc.length ? msg.bcc : undefined,
    replyTo: msg.replyTo ?? undefined,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    attachments: msg.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content }))
  });
  const root = composer.compile();
  (root as unknown as { keepBcc: boolean }).keepBcc = true;
  return new Promise((resolve, reject) => {
    root.build((err, message) => (err ? reject(err) : resolve(message)));
  });
}
