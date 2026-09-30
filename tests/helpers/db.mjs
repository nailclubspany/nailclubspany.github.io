// Test-only harness: spins up a fresh PGlite (Postgres in WASM) database,
// stubs the parts of Supabase that migrations assume exist (anon/authenticated
// roles, the realtime schema), then runs every migration in supabase/migrations/
// in filename order. Mirrors what a real Supabase project already provides, so
// the migration SQL itself never creates these stubs.
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));

const SUPABASE_STUBS = `
  create role anon;
  create role authenticated;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;

  create schema realtime;
  create table realtime.sent(payload jsonb, event text, topic text, private boolean);
  create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
    returns void language sql as $$ insert into realtime.sent values (payload, event, topic, private) $$;
`;

// Fresh DB with Supabase stubs + all migrations applied, connected as superuser.
export async function newDb() {
  const db = new PGlite({ extensions: { btree_gist } });
  await db.exec(SUPABASE_STUBS);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    await db.exec(sql);
  }

  return db;
}

// Runs fn() with the Postgres role switched to `role`, then always resets it
// back — even if fn() throws — so later assertions in the same test run as
// superuser again.
export async function asRole(db, role, fn) {
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
  }
}
