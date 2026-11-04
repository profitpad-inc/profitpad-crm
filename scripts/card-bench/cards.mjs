// Synthetic business cards for comparing card readers (see README.md).
// Every person, company and number here is made up. Renders each card to
// out/clean/<id>.png (1050 x 600, a 3.5 x 2 inch card at 300 dpi; portrait
// cards 600 x 1050) and writes the known answers to out/truth.json.
//
//   node scripts/card-bench/cards.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../api/package.json'));
const { chromium } = require('playwright-core');

// first, last, title, company, email, phones [main first], website, street, city, province, postal, country, template, extra lines
const CARDS = [
  { first: 'Dana', last: 'Whitfield', title: 'Director of Business Development', company: 'Northgate Avionics', email: 'dana.whitfield@northgateavionics.com', phones: [['Direct', '+1 613 555 0142'], ['Mobile', '+1 613 555 0199']], website: 'northgateavionics.com', street: '1200 Merivale Road, Suite 400', city: 'Ottawa', province: 'ON', postal: 'K2C 3P4', country: 'CA', template: 'classic' },
  { first: 'Marcus', last: 'Okafor', title: 'VP Engineering', company: 'Tessellate Systems', email: 'm.okafor@tessellatesys.io', phones: [['', '(512) 555-0117']], website: 'www.tessellatesys.io', street: '901 Congress Ave', city: 'Austin', province: 'TX', postal: '78701', country: 'US', template: 'centered' },
  { first: 'Priya', last: 'Raman', title: 'Senior Program Manager', company: 'Halcyon Defense Group', email: 'praman@halcyondg.com', phones: [['T', '703.555.0163'], ['M', '571.555.0108']], website: 'halcyondg.com', street: '4100 N Fairfax Dr', city: 'Arlington', province: 'VA', postal: '22203', country: 'US', template: 'dark' },
  { first: 'Col. Andrew', last: 'Mercer', title: 'Program Executive Officer', company: 'US Army PEO Sensors', email: 'andrew.j.mercer.mil@army.mil', phones: [['Comm', '(410) 555-0124'], ['DSN', '312-555-0124']], website: '', street: '6001 Combat Drive', city: 'Aberdeen Proving Ground', province: 'MD', postal: '21005', country: 'US', template: 'military', truthFirst: 'Andrew', truthTitle: 'Program Executive Officer' },
  { first: 'Sophie', last: 'Tremblay', title: 'Directrice des ventes / Sales Director', company: 'Aérospatiale Boréal', email: 'stremblay@boreal-aero.ca', phones: [['Tél.', '514 555-0131'], ['Cell.', '438 555-0177']], website: 'boreal-aero.ca', street: '2500 boul. Côte-Vertu', city: 'Montréal', province: 'QC', postal: 'H4R 1P8', country: 'CA', template: 'bilingual' },
  { first: 'Kenji', last: 'Watanabe', title: 'Chief Technology Officer', company: 'Lumenfield Robotics', email: 'kenji@lumenfield.ai', phones: [['', '+1 (415) 555-0186']], website: 'lumenfield.ai', street: '535 Mission St, 14th Floor', city: 'San Francisco', province: 'CA', postal: '94105', country: 'US', template: 'band' },
  { first: 'Rebecca', last: 'Lindqvist', title: 'Account Executive, Federal', company: 'Corvane Data', email: 'rebecca.lindqvist@corvane.com', phones: [['Office', '202-555-0154 ext. 312'], ['Mobile', '202-555-0193']], website: 'corvane.com', street: '1100 New York Ave NW', city: 'Washington', province: 'DC', postal: '20005', country: 'US', template: 'twocol' },
  { first: 'Tomás', last: 'Esparza', title: 'Field Applications Engineer', company: 'Brightline Sensors', email: 'tesparza@brightlinesensors.com', phones: [['', '520-555-0129']], website: 'brightlinesensors.com', street: '7400 S Nogales Hwy', city: 'Tucson', province: 'AZ', postal: '85756', country: 'US', template: 'portrait' },
  { first: 'Fiona', last: 'MacLeod', title: 'Managing Partner', company: 'Strathmore Advisory', email: 'fiona@strathmore-advisory.com', phones: [['', '604 555 0112']], website: 'strathmore-advisory.com', street: '1055 W Georgia St', city: 'Vancouver', province: 'BC', postal: 'V6E 3P3', country: 'CA', template: 'script' },
  { first: 'Lt Cdr Jamal', last: 'Haddad', title: 'Requirements Officer', company: 'Royal Canadian Navy', email: 'jamal.haddad@forces.gc.ca', phones: [['Tel', '902-555-0147'], ['Fax', '902-555-0148']], website: '', street: 'PO Box 99000, Stn Forces', city: 'Halifax', province: 'NS', postal: 'B3K 5X5', country: 'CA', template: 'military', truthFirst: 'Jamal', truthTitle: 'Requirements Officer' },
  { first: 'Grace', last: 'Abernathy', title: 'Contracts Specialist', company: 'Meridian Shipworks', email: 'gabernathy@meridianshipworks.com', phones: [['P', '757.555.0175'], ['F', '757.555.0176']], website: 'meridianshipworks.com', street: '3 Commercial Pl', city: 'Norfolk', province: 'VA', postal: '23510', country: 'US', template: 'dense' },
  { first: 'Oliver', last: 'Pemberton-Hayes', title: 'Head of Partnerships', company: 'Quillon Analytics', email: 'oliver.ph@quillon.co', phones: [['', '+1 646 555 0138']], website: 'quillon.co', street: '230 Park Ave S', city: 'New York', province: 'NY', postal: '10003', country: 'US', template: 'logo' },
  { first: 'Ana', last: 'Kowalczyk', title: 'Procurement Lead', company: 'Westbrook Composites', email: 'ana.kowalczyk@westbrookcomposites.com', phones: [['Main', '316-555-0100'], ['Direct', '316-555-0161']], website: 'westbrookcomposites.com', street: '8800 E Central Ave', city: 'Wichita', province: 'KS', postal: '67206', country: 'US', template: 'classic', mainIndex: 1 },
  { first: 'Darnell', last: 'Brooks', title: 'Sales Manager, Counter-UAS', company: 'Skyward Interdiction', email: 'dbrooks@skywardinterdict.com', phones: [['', '(256) 555-0158']], website: 'skywardinterdict.com', street: '4800 Bradford Dr NW', city: 'Huntsville', province: 'AL', postal: '35805', country: 'US', template: 'dark' },
  { first: 'Ingrid', last: 'Solberg', title: 'Technical Director', company: 'Polaris Maritime Research', email: 'i.solberg@polarismr.org', phones: [['', '709-555-0119']], website: 'polarismr.org', street: '1 Water St E', city: "St. John's", province: 'NL', postal: 'A1C 6H3', country: 'CA', template: 'centered' },
  { first: 'Victor', last: 'Nakamura-Ruiz', title: 'President & CEO', company: 'Ironclad Logistics', email: 'victor@ironcladlogistics.com', phones: [['Cell', '305 555 0181']], website: 'ironcladlogistics.com', street: '2850 NW 79th Ave', city: 'Miami', province: 'FL', postal: '33122', country: 'US', template: 'band' },
  { first: 'Hannah', last: 'Oyelaran', title: 'Business Development Representative', company: 'Cinderwell Labs', email: 'hannah.oyelaran@cinderwell.com', phones: [['', '617-555-0126']], website: 'cinderwell.com', street: '1 Kendall Sq, Bldg 1400', city: 'Cambridge', province: 'MA', postal: '02139', country: 'US', template: 'portrait' },
  { first: 'Sgt. Maj. Carlos', last: 'Rivera', title: 'Senior Enlisted Advisor', company: 'USMC Systems Command', email: 'carlos.rivera@usmc.mil', phones: [['', '(703) 555-0133']], website: '', street: '2200 Lester St', city: 'Quantico', province: 'VA', postal: '22134', country: 'US', template: 'military', truthFirst: 'Carlos', truthTitle: 'Senior Enlisted Advisor' },
  { first: 'Elise', last: 'Fontaine', title: 'Marketing Coordinator', company: 'Vireo Instruments', email: 'efontaine@vireo-instruments.com', phones: [['', '403-555-0172']], website: 'vireo-instruments.com', street: '700 2 St SW', city: 'Calgary', province: 'AB', postal: 'T2P 2W2', country: 'CA', template: 'twocol' },
  { first: 'Benjamin', last: 'Achebe', title: 'Solutions Architect', company: 'Graniteview Cloud', email: 'ben.achebe@graniteview.cloud', phones: [['Phone', '+1 303 555 0145']], website: 'graniteview.cloud', street: '1801 California St', city: 'Denver', province: 'CO', postal: '80202', country: 'US', template: 'logo' },
  { first: 'Mei', last: 'Lin', title: 'Export Compliance Manager', company: 'Atlas Precision Optics', email: 'mei.lin@atlasprecision.com', phones: [['O', '585.555.0167'], ['M', '585.555.0104']], website: 'atlasprecision.com', street: '45 Industrial Pkwy', city: 'Rochester', province: 'NY', postal: '14624', country: 'US', template: 'dense' },
  { first: 'Patrick', last: "O'Sullivan", title: 'Regional Sales Director', company: 'Keystone Armor', email: 'posullivan@keystonearmor.com', phones: [['', '412-555-0151']], website: 'keystonearmor.com', street: '600 Grant St', city: 'Pittsburgh', province: 'PA', postal: '15219', country: 'US', template: 'script' },
  { first: 'Nadia', last: 'Petrova', title: 'Operations Manager', company: 'Frostline Energy', email: 'nadia.petrova@frostline.energy', phones: [['', '780 555 0123']], website: 'frostline.energy', street: '10180 101 St NW', city: 'Edmonton', province: 'AB', postal: 'T5J 3S4', country: 'CA', template: 'bilingual' },
  { first: 'Samuel', last: 'Ortega', title: 'Owner', company: 'Ortega Machine & Tool', email: 'sam@ortegamachine.com', phones: [['Shop', '(915) 555-0114'], ['Cell', '(915) 555-0187']], website: 'ortegamachine.com', street: '1440 Gateway Blvd W', city: 'El Paso', province: 'TX', postal: '79903', country: 'US', template: 'classic' }
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const addr = (c) => `${esc(c.street)}<br>${esc(c.city)}, ${esc(c.province)} ${esc(c.postal)}${c.country === 'CA' ? '<br>Canada' : ''}`;
const phones = (c, sep = '<br>') => c.phones.map(([l, n]) => (l ? `${esc(l)} ${esc(n)}` : esc(n))).join(sep);
const initials = (c) => c.company.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const logo = (c, color) => `<svg width="90" height="90" viewBox="0 0 90 90"><circle cx="45" cy="45" r="40" fill="${color}"/><path d="M20 60 L45 20 L70 60 Z" fill="#fff" opacity=".85"/><text x="45" y="78" font-size="14" text-anchor="middle" fill="#fff" font-family="Arial" font-weight="700">${initials(c)}</text></svg>`;

const TEMPLATES = {
  classic: (c) => `<div class="card" style="background:#fff;color:#1b1f24;padding:70px 80px;font-family:Georgia,serif">
    <div style="font-size:30px;letter-spacing:3px;text-transform:uppercase;color:#7a5c2e">${esc(c.company)}</div>
    <div style="margin-top:70px;font-size:52px">${esc(c.first)} ${esc(c.last)}</div>
    <div style="font-size:28px;font-style:italic;color:#555">${esc(c.title)}</div>
    <div style="position:absolute;right:80px;bottom:70px;text-align:right;font-size:24px;line-height:1.5">${phones(c)}<br>${esc(c.email)}<br>${esc(c.website)}</div>
    <div style="position:absolute;left:80px;bottom:70px;font-size:22px;line-height:1.45;color:#444">${addr(c)}</div></div>`,
  centered: (c) => `<div class="card" style="background:#f6f4ef;color:#222;text-align:center;padding-top:110px;font-family:Helvetica,Arial,sans-serif">
    <div style="font-size:50px;font-weight:300">${esc(c.first)} ${esc(c.last)}</div>
    <div style="font-size:24px;color:#888;letter-spacing:2px;text-transform:uppercase;margin-top:10px">${esc(c.title)}</div>
    <div style="font-size:32px;font-weight:700;margin-top:40px">${esc(c.company)}</div>
    <div style="font-size:22px;margin-top:40px;color:#444">${phones(c, '  ·  ')}  ·  ${esc(c.email)}</div>
    <div style="font-size:20px;margin-top:10px;color:#666">${esc(c.street)}, ${esc(c.city)}, ${esc(c.province)} ${esc(c.postal)}  ·  ${esc(c.website)}</div></div>`,
  dark: (c) => `<div class="card" style="background:#0d1b2a;color:#e0e6ee;padding:80px;font-family:'Avenir Next',Arial,sans-serif">
    <div style="position:absolute;right:80px;top:70px">${logo(c, '#c9a227')}</div>
    <div style="font-size:30px;font-weight:700;color:#c9a227">${esc(c.company)}</div>
    <div style="font-size:48px;margin-top:60px;font-weight:600">${esc(c.first)} ${esc(c.last)}</div>
    <div style="font-size:26px;color:#9fb0c3">${esc(c.title)}</div>
    <div style="margin-top:40px;font-size:22px;line-height:1.5;color:#c8d2de">${phones(c, '   ')}<br>${esc(c.email)}  |  ${esc(c.website)}<br>${esc(c.street)}, ${esc(c.city)}, ${esc(c.province)} ${esc(c.postal)}</div></div>`,
  military: (c) => `<div class="card" style="background:#fff;color:#111;font-family:'Times New Roman',serif;padding:60px 70px">
    <div style="display:flex;gap:40px;align-items:center"><svg width="150" height="150" viewBox="0 0 150 150"><circle cx="75" cy="75" r="70" fill="#2f3b1f"/><circle cx="75" cy="75" r="56" fill="none" stroke="#d4af37" stroke-width="4"/><polygon points="75,30 86,62 120,62 92,82 103,115 75,95 47,115 58,82 30,62 64,62" fill="#d4af37"/></svg>
    <div><div style="font-size:26px;font-weight:700;letter-spacing:1px;text-transform:uppercase">${esc(c.company)}</div>
    <div style="font-size:46px;margin-top:20px">${esc(c.first)} ${esc(c.last)}</div><div style="font-size:26px">${esc(c.title)}</div></div></div>
    <div style="margin-top:45px;font-size:23px;line-height:1.5;text-align:center">${esc(c.street)} · ${esc(c.city)}, ${esc(c.province)} ${esc(c.postal)}<br>${phones(c, '   ')}<br>${esc(c.email)}</div></div>`,
  bilingual: (c) => `<div class="card" style="background:#fff;color:#222;font-family:Arial,sans-serif;display:flex">
    <div style="width:30px;background:#d52b1e"></div><div style="padding:70px 70px">
    <div style="font-size:30px;font-weight:700;color:#d52b1e">${esc(c.company)}</div>
    <div style="font-size:46px;margin-top:50px">${esc(c.first)} ${esc(c.last)}</div><div style="font-size:24px;color:#555">${esc(c.title)}</div>
    <div style="margin-top:40px;font-size:22px;line-height:1.5">${addr(c)}<br>${phones(c, '   ')}<br>${esc(c.email)}  ·  ${esc(c.website)}</div></div></div>`,
  band: (c) => `<div class="card" style="background:#fff;font-family:Futura,'Trebuchet MS',sans-serif;color:#222">
    <div style="background:linear-gradient(90deg,#ff5f6d,#ffc371);height:180px;padding:50px 70px;color:#fff;font-size:56px;font-weight:700">${esc(c.company)}</div>
    <div style="padding:40px 70px"><div style="font-size:40px;font-weight:600">${esc(c.first)} ${esc(c.last)}</div><div style="font-size:24px;color:#777">${esc(c.title)}</div>
    <div style="margin-top:30px;font-size:21px;line-height:1.5">${phones(c, '   ')}  ·  ${esc(c.email)}<br>${esc(c.website)}  ·  ${esc(c.street)}, ${esc(c.city)}, ${esc(c.province)} ${esc(c.postal)}</div></div></div>`,
  twocol: (c) => `<div class="card" style="background:#fff;font-family:'Gill Sans',Arial,sans-serif;color:#1d2b36;display:flex">
    <div style="width:45%;background:#e8eef3;padding:80px 50px"><div style="font-size:44px;font-weight:600;line-height:1.15">${esc(c.first)}<br>${esc(c.last)}</div><div style="font-size:23px;margin-top:20px;color:#4b5d6b">${esc(c.title)}</div><div style="font-size:26px;font-weight:700;margin-top:60px">${esc(c.company)}</div></div>
    <div style="padding:90px 50px;font-size:23px;line-height:1.65">${phones(c)}<br>${esc(c.email)}<br>${esc(c.website)}<br><br>${addr(c)}</div></div>`,
  portrait: (c) => `<div class="card portrait" style="background:#fafafa;font-family:Verdana,sans-serif;color:#222;padding:80px 60px;text-align:center">
    <div>${logo(c, '#2a9d8f')}</div><div style="font-size:30px;font-weight:700;margin-top:20px">${esc(c.company)}</div>
    <div style="font-size:40px;margin-top:120px">${esc(c.first)}<br>${esc(c.last)}</div><div style="font-size:22px;color:#666;margin-top:12px">${esc(c.title)}</div>
    <div style="font-size:20px;margin-top:110px;line-height:1.6">${phones(c)}<br>${esc(c.email)}<br>${esc(c.website)}<br>${addr(c)}</div></div>`,
  script: (c) => `<div class="card" style="background:#fffdf7;color:#2b2b2b;padding:80px;font-family:Didot,Georgia,serif;text-align:center">
    <div style="font-family:'Snell Roundhand','Brush Script MT',cursive;font-size:72px">${esc(c.first)} ${esc(c.last)}</div>
    <div style="font-size:22px;letter-spacing:4px;text-transform:uppercase;color:#8a7350;margin-top:10px">${esc(c.title)}</div>
    <div style="font-size:28px;margin-top:50px">${esc(c.company)}</div>
    <div style="font-size:20px;margin-top:40px;color:#555">${phones(c, ' · ')} · ${esc(c.email)}<br>${esc(c.street)}, ${esc(c.city)}, ${esc(c.province)} ${esc(c.postal)} · ${esc(c.website)}</div></div>`,
  dense: (c) => `<div class="card" style="background:#fff;color:#333;padding:50px 60px;font-family:Arial,sans-serif;font-size:17px;line-height:1.35">
    <div style="display:flex;justify-content:space-between"><div><b style="font-size:24px">${esc(c.company)}</b><br>A subsidiary of ${esc(c.company)} Holdings LLC<br>ISO 9001:2015 · AS9100D · ITAR Registered</div>${logo(c, '#264653')}</div>
    <div style="margin-top:30px"><b style="font-size:30px">${esc(c.first)} ${esc(c.last)}</b><br>${esc(c.title)}</div>
    <div style="margin-top:25px;columns:2;column-gap:40px">${addr(c)}<br>${phones(c)}<br>${esc(c.email)}<br>${esc(c.website)}<br>CAGE 1ABC2 · UEI ZQ12AB34CD56</div></div>`,
  logo: (c) => `<div class="card" style="background:#fff;color:#111;font-family:'Helvetica Neue',Arial,sans-serif;padding:70px">
    <div style="display:flex;align-items:center;gap:24px">${logo(c, '#6a4c93')}<div style="font-size:44px;font-weight:800;letter-spacing:-1px;color:#6a4c93">${esc(c.company.toLowerCase())}</div></div>
    <div style="margin-top:60px;font-size:38px;font-weight:700">${esc(c.first)} ${esc(c.last)}</div><div style="font-size:24px;color:#666">${esc(c.title)}</div>
    <div style="position:absolute;right:70px;bottom:60px;font-size:21px;text-align:right;line-height:1.5">${phones(c)}<br>${esc(c.email)}<br>${esc(c.website)}<br>${esc(c.city)}, ${esc(c.province)}</div></div>`
};

const digits = (s) => s.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

const truth = CARDS.map((c, i) => {
  const id = String(i + 1).padStart(2, '0');
  const main = c.phones[c.mainIndex ?? 0][1];
  return {
    id,
    template: c.template,
    portrait: c.template === 'portrait',
    first_name: c.truthFirst ?? c.first,
    last_name: c.last,
    job_title: c.truthTitle ?? c.title,
    company: c.company,
    email: c.email,
    phone: digits(main.replace(/ext.*$/i, '')),
    all_phones: c.phones.map(([, n]) => digits(n.replace(/ext.*$/i, ''))),
    website: c.website,
    address_city: c.city,
    address_province: c.province,
    // the logo template prints only the city and province
    address_postalcode: c.template === 'logo' ? '' : c.postal,
    address_country: c.country
  };
});

const outDir = path.join(here, 'out');
await mkdir(path.join(outDir, 'clean'), { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [i, c] of CARDS.entries()) {
  const t = truth[i];
  const [w, h] = t.portrait ? [600, 1050] : [1050, 600];
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0}.card{position:relative;width:${w}px;height:${h}px;box-sizing:border-box;overflow:hidden}</style>${TEMPLATES[c.template](c)}`);
  await page.screenshot({ path: path.join(outDir, 'clean', `${t.id}.png`) });
}
await browser.close();
await writeFile(path.join(outDir, 'truth.json'), JSON.stringify(truth, null, 2));
console.log(`rendered ${CARDS.length} cards to ${path.join(outDir, 'clean')}`);
