import { Link } from 'react-router-dom';
import { MENTION_TOKEN } from '../lib/text-complete';

// Text with @[Name](<user id>) tokens (notes): each token shows as a
// highlighted @Name linking to the user, the rest as plain text.
export function MentionText({ text }: { text: string }) {
  const parts: (string | { name: string; id: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_TOKEN)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push({ name: m[1], id: m[2] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <>
      {parts.map((p, i) => typeof p === 'string'
        ? p
        : <Link key={i} to={`/objects/users/${p.id}`} className="mention" onClick={(e) => e.stopPropagation()}>@{p.name}</Link>)}
    </>
  );
}
