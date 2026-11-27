// A compiled query with its bound values written into the text, for people to
// read ("View SQL" on a list). Display only: queries always run with their
// parameters bound, never from this text.

function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return quote(v.toISOString());
  if (Array.isArray(v)) return `ARRAY[${v.map(literal).join(', ')}]`;
  if (typeof v === 'object') return quote(JSON.stringify(v));
  return quote(String(v));
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// $1, $2, ... become their values. Placeholders are only ever $ and digits
// outside string literals in the queries this renders, and the longest number
// matches first, so $12 is never read as $1 then 2.
export function renderSql(sql: string, params: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (m, n: string) => {
    const i = Number(n) - 1;
    return i >= 0 && i < params.length ? literal(params[i]) : m;
  });
}

// Lays the generated query out to read top to bottom: from, where and each
// and / or on a line of its own, indented by how deep in brackets it sits.
// Text in quotes is left alone.
const BREAK = /^ (from|where|and|or|order by|limit) /i;

export function formatSql(sql: string): string {
  const s = sql.replace(/\s+/g, ' ').trim();
  let out = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      // a doubled quote inside a literal: keep scanning
      let j = end;
      while (j !== -1 && s[j + 1] === "'") j = s.indexOf("'", j + 2);
      const stop = j === -1 ? s.length - 1 : j;
      out += s.slice(i, stop + 1);
      i = stop;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    const m = ch === ' ' ? BREAK.exec(s.slice(i)) : null;
    if (m) {
      out += '\n' + '  '.repeat(depth + (/^(and|or)$/i.test(m[1]) ? 1 : 0)) + m[1] + ' ';
      i += m[0].length - 1;
      continue;
    }
    out += ch;
  }
  return out;
}
