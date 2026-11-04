// Reads the card photos with Claude through the CRM's own reader
// (api/src/card-scan.ts readCard), for comparison with the open-source
// readers (see README.md). Needs ANTHROPIC_API_KEY in api/.env.
//
//   cd api && npx tsx --env-file=.env ../scripts/card-bench/claude.mts [model ...]
//
// Writes out/claude/<model>/<level>/<id>.json: the fields and the seconds taken.

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCard } from '../../api/src/card-scan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
const models = process.argv.slice(2).length ? process.argv.slice(2) : ['claude-haiku-5-5', 'claude-opus-5-5'];
const levels = ['clean', 'photo', 'hard'];
const truth: { id: string }[] = JSON.parse(await readFile(path.join(out, 'truth.json'), 'utf8'));

const jobs: (() => Promise<void>)[] = [];
for (const model of models) {
  for (const level of levels) {
    const dir = path.join(out, 'claude', model, level);
    await mkdir(dir, { recursive: true });
    for (const t of truth) {
      const file = path.join(dir, `${t.id}.json`);
      jobs.push(async () => {
        if (await access(file).then(() => true, () => false)) return; // already read
        const ext = level === 'clean' ? 'png' : 'jpg';
        const image = await readFile(path.join(out, level, `${t.id}.${ext}`));
        const start = Date.now();
        try {
          const { fields } = await readCard(image, ext === 'png' ? 'image/png' : 'image/jpeg', { apiKey: process.env.ANTHROPIC_API_KEY ?? '', model });
          await writeFile(file, JSON.stringify({ fields, seconds: (Date.now() - start) / 1000 }, null, 1));
        } catch (err) {
          console.error(`${model} ${level} ${t.id}: ${(err as Error).message}`);
        }
      });
    }
  }
}

// a few at a time
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < jobs.length) await jobs[next++]();
}));
console.log(`read ${jobs.length} cards with ${models.join(', ')}`);
process.exit(0);
