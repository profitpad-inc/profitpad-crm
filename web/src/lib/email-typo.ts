// Addresses one typo away from gmail.com (gmail.co, gnail.com, gmial.com) are
// refused where people type their own email, the same rule as the Nibly
// booking page. api/src/email-typo.ts is the server copy; keep them alike.

// Edit distance with swapped neighbours counted as one edit, so gmial.com is
// one away like gnail.com.
function distance(a: string, b: string): number {
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) d[i] = [i];
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// mail.com and email.com are real providers, not gmail typos.
const REAL = new Set(['mail.com', 'email.com']);

export function isGmailTypo(email: string): boolean {
  const domain = email.trim().toLowerCase().split('@')[1] ?? '';
  return !!domain && !REAL.has(domain) && distance(domain, 'gmail.com') === 1;
}

export const GMAIL_TYPO_MESSAGE = 'Did you mean @gmail.com? Please check your email address.';
