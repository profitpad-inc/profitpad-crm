// Creates an API key directly in the database (used to bootstrap the first
// admin key, since creating keys through the API needs an admin key).
//   npm run create-key -- --name "Chris" --scopes admin --user <user id> [--days 90|180|365]
//   npm run create-key -- --name "Setup" --scopes admin --bootstrap
// Every key belongs to a user, like keys made through the API. --bootstrap
// makes a userless key that expires after 24 hours, for setting up a new
// database before any user exists.
import { parseArgs } from 'node:util';
import { pool } from '../db.js';
import { generateKey, hashKey } from '../auth.js';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    scopes: { type: 'string', default: 'read' },
    user: { type: 'string' },
    days: { type: 'string', default: '90' },
    bootstrap: { type: 'boolean', default: false }
  }
});

const usage = 'usage: npm run create-key -- --name "<name>" --scopes read,write,schema,admin (--user <user id> [--days 90|180|365] | --bootstrap)';
if (!values.name || (!values.user && !values.bootstrap) || (values.user && values.bootstrap)) {
  console.error(usage);
  process.exit(1);
}
const days = Number(values.days);
if (!values.bootstrap && ![90, 180, 365].includes(days)) {
  console.error('--days must be 90, 180 or 365');
  process.exit(1);
}

const { key, prefix } = generateKey();
const scopes = values.scopes!.split(',').map((s) => s.trim());
const { rows } = await pool.query(
  `insert into auth.api_keys (name, key_prefix, key_hash, user_id, scopes, expires_at, created_by)
   values ($1, $2, $3, $4, $5, now() + make_interval(hours => $6), 'cli') returning id, expires_at`,
  [values.name, prefix, hashKey(key), values.user ?? null, scopes, values.bootstrap ? 24 : days * 24]
);
await pool.query(
  `insert into auth.security_events (event, actor, user_id, target_type, target_id, details)
   values ('api_key.created', 'cli', $1, 'api_key', $2, $3)`,
  [values.user ?? null, rows[0].id, JSON.stringify({ name: values.name, prefix, scopes, bootstrap: values.bootstrap, expires_at: rows[0].expires_at })]
);
console.log(`created key ${rows[0].id} (${values.name}, scopes: ${scopes.join(', ')}, expires ${rows[0].expires_at.toISOString()})`);
console.log(key);
console.log('store it now; it is never shown again');
await pool.end();
