// Asks Claude where the card is in each phone photo, through the CRM's own
// reader (api/src/card-scan.ts readCard, which returns card_corners with the
// fields), for corners-score.py to compare with the true corners that
// photos.py saved. Needs ANTHROPIC_API_KEY in api/.env.
//
//   cd api && npx tsx --env-file=.env ../scripts/card-bench/corners.mts [model]
//
// Writes out/corners/<model>/<level>/<id>.json: corners, tokens, seconds.

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCard } from '../../api/src/card-scan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
const model = process.argv[2] ?? 'claude-haiku-5-5';
const truth: { id: string }[] = JSON.parse(await readFile(path.join(out, 'truth.json'), 'utf8'));

const jobs: (() => Promise<void>)[] = [];
for (const level of ['photo', 'hard']) {
  const dir = path.join(out, 'corners', model, level);
  await mkdir(dir, { recursive: true });
  for (const t of truth) {
    const file = path.join(dir, `${t.id}.json`);
    jobs.push(async () => {
      if (await access(file).then(() => true, () => false)) return; // already asked
      const image = await readFile(path.join(out, level, `${t.id}.jpg`));
      const start = Date.now();
      try {
        const r = await readCard(image, 'image/jpeg', { apiKey: process.env.ANTHROPIC_API_KEY ?? '', model });
        await writeFile(file, JSON.stringify({ corners: r.fields.card_corners ?? null, usage: r.usage, seconds: (Date.now() - start) / 1000 }, null, 1));
      } catch (err) {
        console.error(`${level} ${t.id}: ${(err as Error).message}`);
      }
    });
  }
}

let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < jobs.length) await jobs[next++]();
}));
console.log(`asked ${model} about ${jobs.length} photos`);
process.exit(0);
