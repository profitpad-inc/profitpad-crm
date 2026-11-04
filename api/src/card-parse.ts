// Sorts the raw text Tesseract reads off a business card into contact fields
// (card-scan.ts uses it when the reader is Tesseract; Claude returns fields
// itself). Rules, not a model: email, website and phones by pattern, phones
// checked with libphonenumber, the address from a "City, ST postal" line, the
// company by matching the email or website domain, the name by matching the
// email's local part, the title by keywords. Prototyped and measured in
// scripts/card-bench (parse.py).

import type { CardFields } from './card-scan.js';
import { checkPhone } from './phone.js';

export interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrLine {
  text: string;
  box: [number, number, number, number];
}

// Words on about the same height become a line, left to right; a wide gap
// splits a row in two (two columns side by side). Lines come out top to bottom.
export function wordsToLines(words: OcrWord[]): OcrLine[] {
  const rows: { cy: number; h: number; words: OcrWord[] }[] = [];
  for (const w of [...words].filter((w) => w.text.trim()).sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1))) {
    const cy = (w.y0 + w.y1) / 2;
    const h = w.y1 - w.y0;
    const row = rows.find((r) => Math.abs(r.cy - cy) < 0.5 * Math.max(h, r.h));
    if (row) row.words.push(w);
    else rows.push({ cy, h, words: [w] });
  }
  const lines: OcrLine[] = [];
  for (const r of rows) {
    const ws = r.words.sort((a, b) => a.x0 - b.x0);
    let group = [ws[0]];
    const flush = () => lines.push({
      text: group.map((w) => w.text).join(' ').trim(),
      box: [Math.min(...group.map((w) => w.x0)), Math.min(...group.map((w) => w.y0)), Math.max(...group.map((w) => w.x1)), Math.max(...group.map((w) => w.y1))]
    });
    for (let i = 1; i < ws.length; i++) {
      if (ws[i].x0 - ws[i - 1].x1 > 2.5 * r.h) {
        flush();
        group = [];
      }
      group.push(ws[i]);
    }
    flush();
  }
  return lines.sort((a, b) => Math.round(a.box[1] / 20) - Math.round(b.box[1] / 20) || a.box[0] - b.box[0]);
}

// Tesseract's TSV output (tesseract <image> stdout tsv) to words, dropping low-confidence ones.
export function wordsFromTsv(tsv: string, minConfidence = 30): OcrWord[] {
  const words: OcrWord[] = [];
  for (const row of tsv.split('\n').slice(1)) {
    const c = row.split('\t');
    if (c.length < 12 || !c[11]?.trim() || Number(c[10]) < minConfidence) continue;
    const [x, y, w, h] = [Number(c[6]), Number(c[7]), Number(c[8]), Number(c[9])];
    words.push({ text: c[11].trim(), x0: x, y0: y, x1: x + w, y1: y + h });
  }
  return words;
}

const EMAIL = /[A-Za-z0-9._%+'-]+\s?@\s?[A-Za-z0-9-]+(?:\s?\.\s?[A-Za-z0-9-]+)+/;
const WEB = /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ca|io|ai|co|org|net|gov|mil|us|cloud|energy|tech|uk|de|fr|eu|biz|info|app|dev))\b/i;
const LINKEDIN = /\b(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+/i;
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}(?:\s*(?:ext\.?|x)\s*\d+)?/gi;
const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR'.split(' '));
const CA_PROVINCES = new Set('AB BC MB NB NL NS NT NU ON PE QC SK YT'.split(' '));
const CITY_REGION = /([A-Za-zÀ-ÿ.' -]+?)\s*,?\s*\b([A-Z]{2})\b(?:\s+([A-Z]\d[A-Z]\s?\d[A-Z]\d|\d{5}(?:-\d{4})?))?/g;
const PHONE_LABEL = /(direct|mobile|cell|tel|tél|phone|office|main|comm|shop|dsn|fax|work|[tmpfoc])\.?\s*:?\s*$/i;
const NOT_A_VOICE_LINE = /^(f|fax|dsn)$/i;
const RANKS = /^(?:(?:col|lt|cdr|ltcol|lcol|maj|capt|cpt|gen|sgt|msgt|ssgt|cpl|adm|cmdr|dr|mr|mrs|ms|prof)\.?\s+)+/i;
const TITLE_WORDS = /\b(director|directrice|directeur|manager|vp|vice president|president|ceo|cto|cfo|coo|cio|chief|officer|engineer|architect|partner|head|lead|specialist|coordinator|executive|representative|advisor|adviser|owner|founder|consultant|analyst|sales|marketing|operations|program|account|technical|senior|principal|associate|assistant|commander|attaché|attache)\b/i;
const COMPANY_WORDS = /\b(inc|llc|ltd|limited|corp|corporation|company|group|systems|labs|technologies|technology|solutions|analytics|logistics|instruments|robotics|sensors|data|cloud|energy|advisory|composites|industries|optics|research|avionics|defen[cs]e|navy|army|air force|command|agency|department|ministry|university|aerospace|aérospatiale|international|partners|consulting|services)\b/i;
const NOISE = /\b(iso\s?\d|as9100|itar|cage|uei|duns|subsidiary|registered|canada|united states|usa)\b/i;
// a logo read as a few stray characters before the real text: "A) quillon", "@ Acme"
const LOGO_JUNK = /^(?:[^A-Za-zÀ-ÿ0-9\s]{1,3}|[A-Za-z0-9]{1,2}[)\]}|>»])\s+/;

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

function emptyFields(): CardFields {
  return {
    is_business_card: false, first_name: '', last_name: '', job_title: '', department: '', company: '', email: '', phone: '', other_phones: [],
    website: '', linkedin_url: '', address_street_1: '', address_street_2: '', address_city: '', address_province: '', address_postalcode: '',
    address_country: '', other_text: ''
  };
}

export function parseCard(input: (OcrLine | string)[], defaultRegion?: string): CardFields {
  const texts = input.map((l) => (typeof l === 'string' ? l : l.text).trim().replace(LOGO_JUNK, '')).filter(Boolean);
  const out = emptyFields();
  const used = new Set<number>();

  // email, LinkedIn, website
  for (const [i, t] of texts.entries()) {
    const m = EMAIL.exec(t);
    if (m && !out.email) {
      out.email = m[0].replace(/\s/g, '').toLowerCase().replace(/\.$/, '');
      if (t.replace(m[0], '').trim().length < 3) used.add(i);
    }
    const li = LINKEDIN.exec(t);
    if (li && !out.linkedin_url) out.linkedin_url = li[0].replace(/^https?:\/\//, '');
  }
  const emailDomain = out.email.split('@')[1] ?? '';
  for (const t of texts) {
    const m = WEB.exec(t.replace(EMAIL, ' ').replace(LINKEDIN, ' '));
    if (m) {
      out.website = m[1].toLowerCase();
      break;
    }
  }

  // phones: "Direct" wins, otherwise the first that is not a fax or DSN line
  const phones: { label: string; number: string; line: number }[] = [];
  for (const [i, t] of texts.entries()) {
    for (const m of t.matchAll(PHONE)) {
      const label = PHONE_LABEL.exec(t.slice(0, m.index).replace(/[·|•-]\s*$/, ''))?.[1] ?? '';
      phones.push({ label: label.toLowerCase(), number: m[0].trim(), line: i });
    }
  }
  const main = phones.find((p) => p.label.startsWith('direct')) ?? phones.find((p) => !NOT_A_VOICE_LINE.test(p.label));
  for (const p of phones) {
    used.add(p.line);
    if (p === main) continue;
    out.other_phones.push({ label: p.label ? p.label[0].toUpperCase() + p.label.slice(1) : '', number: p.number });
  }
  if (main) {
    const check = checkPhone(main.number, defaultRegion);
    out.phone = check.valid ? (check.display ?? main.number) : main.number;
  }

  // address: "City, ST postal", with the street before it on the line or on the line above
  const isStreet = (s: string) => /^(\d+[a-z]?\s|po box|p\.o\.)/i.test(s.trim());
  address: for (const [i, t] of texts.entries()) {
    const chunks = t.replace(EMAIL, ' ').split(/\s[·|•-]\s|\s{3,}/);
    for (const [ci, chunk] of chunks.entries()) {
      for (const m of chunk.matchAll(CITY_REGION)) {
        const region = m[2];
        if (!US_STATES.has(region) && !CA_PROVINCES.has(region)) continue;
        const postal = m[3] ?? '';
        // without a postal code, only "City, ST" (with the comma) counts
        if (!postal && !new RegExp(`,\\s*${region}\\b`).test(chunk)) continue;
        let city = m[1].trim().replace(/^[,\s]+|[,\s]+$/g, '');
        let street = '';
        if (city.includes(',')) {
          const cut = city.lastIndexOf(',');
          street = city.slice(0, cut).trim();
          city = city.slice(cut + 1).trim();
        } else if (ci > 0 && isStreet(chunks[ci - 1])) {
          street = chunks[ci - 1].trim();
        } else {
          // the line above, or the one above that when another column's line sits between
          const above = [i - 1, i - 2].find((j) => j >= 0 && !used.has(j) && isStreet(texts[j]) && !texts[j].match(PHONE));
          if (above !== undefined) {
            street = texts[above];
            used.add(above);
          }
        }
        if (!city) continue;
        Object.assign(out, {
          address_street_1: street,
          address_city: city,
          address_province: region,
          address_postalcode: postal.toUpperCase().replace(/^([A-Z]\d[A-Z])(\d[A-Z]\d)$/, '$1 $2'),
          address_country: CA_PROVINCES.has(region) ? 'CA' : 'US'
        });
        used.add(i);
        break address;
      }
    }
  }

  // what is left holds the name, title, company and department
  let rest = texts.filter((t, i) =>
    !used.has(i) && !EMAIL.test(t) && !(WEB.test(t) && t.split(/\s+/).length <= 2) && !t.match(PHONE) && !NOISE.test(t) && !/^\d/.test(t));

  const stem = fold((emailDomain || out.website).split('.')[0] ?? '');
  const local = fold(out.email.split('@')[0] ?? '');
  const companyScore = (t: string) => {
    const n = fold(t);
    let s = 0;
    if (stem && n.length >= 3 && (stem.includes(n) || n.includes(stem) || n.slice(0, 6) === stem.slice(0, 6))) s += 3;
    if (COMPANY_WORDS.test(t)) s += 1;
    if (TITLE_WORDS.test(t)) s -= 1;
    return s;
  };
  const nameScore = (t: string) => {
    const words = t.replace(RANKS, '').split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 4 || /[\d@]/.test(t)) return -9;
    let s = 0;
    if (local && words.some((w) => fold(w).length >= 2 && local.includes(fold(w).slice(0, 3)))) s += 3;
    if (words.every((w) => /^\p{Lu}/u.test(w))) s += 1;
    if (words.every((w) => w === w.toUpperCase())) s -= 1;
    if (TITLE_WORDS.test(t) || COMPANY_WORDS.test(t)) s -= 2;
    return s;
  };

  const company = rest.reduce<string | null>((best, t) => (best === null || companyScore(t) > companyScore(best) ? t : best), null);
  if (company && companyScore(company) > 0) {
    out.company = company;
    rest = rest.filter((t) => t !== company);
  }

  // a name may be split over two lines, not always next to each other (two-column cards)
  const singles = rest.filter((t) => /^\p{Lu}[\p{L}'’-]+$/u.test(t));
  const candidates = [...rest];
  for (let a = 0; a < singles.length; a++) for (let b = a + 1; b < Math.min(singles.length, a + 3); b++) candidates.push(`${singles[a]} ${singles[b]}`);
  const name = candidates.reduce<string | null>((best, t) => (best === null || nameScore(t) > nameScore(best) ? t : best), null);
  if (name && nameScore(name) > -9) {
    const parts = name.replace(RANKS, '').split(/\s+/);
    out.first_name = parts.slice(0, -1).join(' ');
    out.last_name = parts[parts.length - 1];
    const pieces = new Set([name, ...name.split(' ')]);
    rest = rest.filter((t) => !pieces.has(t));
  }

  const title = rest.find((t) => TITLE_WORDS.test(t));
  if (title) {
    out.job_title = title;
    rest = rest.filter((t) => t !== title);
  }
  out.other_text = rest.join('\n');
  out.is_business_card = Boolean(out.email || out.phone || (out.first_name && (out.company || out.job_title)));
  return out;
}
