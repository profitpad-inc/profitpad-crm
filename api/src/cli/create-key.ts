// Creates an API key directly in the database (used to bootstrap the first
// admin key, since creating keys through the API needs an admin key).
//   npm run create-key -- --name "Support admin" --scopes admin [--user <user id>]
import { parseArgs } from 'node:util';
import { pool } from '../db.js';
import { generateKey, hashKey } from '../auth.js';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    scopes: { type: 'string', default: 'read' },
    user: { type: 'string' }
  }
});

if (!values.name) {
  console.error('usage: npm run create-key -- --name "<name>" --scopes read,write,schema,admin [--user <user id>]');
  process.exit(1);
}

const { key, prefix } = generateKey();
const scopes = values.scopes!.split(',').map((s) => s.trim());
const { rows } = await pool.query(
  `insert into auth.api_keys (name, key_prefix, key_hash, user_id, scopes, created_by)
   values ($1, $2, $3, $4, $5, 'cli') returning id`,
  [values.name, prefix, hashKey(key), values.user ?? null, scopes]
);
console.log(`created key ${rows[0].id} (${values.name}, scopes: ${scopes.join(', ')})`);
console.log(key);
console.log('store it now; it is never shown again');
await pool.end();
