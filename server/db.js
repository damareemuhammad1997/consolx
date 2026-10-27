/* Postgres: connection, schema (idempotent, applied at start-up) and first-run seed.
   Railway: add the PostgreSQL plugin; it sets DATABASE_URL on the service. */
const { Pool, types } = require('pg');
/* DATE columns as 'YYYY-MM-DD' text, not a JS Date at local midnight (which can shift a day) */
types.setTypeParser(1082, v => v);

const url = process.env.DATABASE_URL;
if(!url) throw new Error('DATABASE_URL is not set — add a PostgreSQL database to the service (Railway: New → Database → PostgreSQL).');
/* no TLS on the same machine or on Railway's private network (postgres.railway.internal does not offer it);
   TLS everywhere else (e.g. Railway's public proxy URL). PGSSL=off / PGSSL=on overrides. */
const host = (() => { try { return new URL(url).hostname; } catch(e){ return ''; } })();
const plain = process.env.PGSSL === 'off' || (process.env.PGSSL !== 'on' && (/^(localhost|127\.0\.0\.1)$/.test(host) || /\.railway\.internal$/.test(host)));
const pool = new Pool({ connectionString: url, ssl: plain ? false : { rejectUnauthorized: false }, max: 10 });

const q = (text, params) => pool.query(text, params);
async function tx(fn){
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch(e){ await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);
/* plans: a client type ('firm' = accounting firm, 'holding' = holding company) and what the plan includes */
CREATE TABLE IF NOT EXISTS tiers (
  id serial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('firm','holding')),
  name text NOT NULL,
  max_users int NOT NULL CHECK (max_users >= 1),
  max_orgs int NOT NULL CHECK (max_orgs >= 1),
  price_monthly numeric(14,2) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS addons (
  key text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_monthly numeric(14,2) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS clients (
  id serial PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('firm','holding')),
  tier_id int NOT NULL REFERENCES tiers(id),
  cycle text NOT NULL DEFAULT 'monthly' CHECK (cycle IN ('monthly','annual')),
  addons text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  billing_email text NOT NULL DEFAULT '',
  billing_address text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS organisations (
  id serial PRIMARY KEY,
  client_id int NOT NULL REFERENCES clients(id),
  name text NOT NULL,
  state jsonb,
  version int NOT NULL DEFAULT 0,
  updated_at timestamptz,
  updated_by int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS organisations_client ON organisations(client_id);
CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  is_superadmin boolean NOT NULL DEFAULT false,
  client_id int REFERENCES clients(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  must_change_password boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (is_superadmin OR client_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (lower(email));
/* which organisations a user opens, and as what: 'admin' (Admin and User views) or 'user' (User view) */
CREATE TABLE IF NOT EXISTS memberships (
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id int NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  PRIMARY KEY (user_id, org_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id int REFERENCES organisations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS invoices (
  id serial PRIMARY KEY,
  client_id int NOT NULL REFERENCES clients(id),
  number text NOT NULL UNIQUE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  cycle text NOT NULL CHECK (cycle IN ('monthly','annual')),
  currency text NOT NULL,
  lines jsonb NOT NULL,
  subtotal numeric(14,2) NOT NULL,
  discount numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','paid','void')),
  gateway text NOT NULL DEFAULT 'manual',
  issued_at timestamptz NOT NULL DEFAULT now(),
  due_date date NOT NULL,
  paid_at timestamptz,
  paid_ref text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_client_period ON invoices(client_id, period_start, cycle) WHERE status <> 'void';
/* discount codes: a percentage off a client's invoices (100% = free, e.g. an internal test client) */
CREATE TABLE IF NOT EXISTS discount_codes (
  code text PRIMARY KEY,
  percent numeric(5,2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  description text NOT NULL DEFAULT '',
  valid_until date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS discount_code text REFERENCES discount_codes(code);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discounts jsonb NOT NULL DEFAULT '[]';
/* Yai (the AI assistant add-on): questions and tokens per organisation and month — nothing of the questions is kept */
CREATE TABLE IF NOT EXISTS ai_usage (
  org_id int NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  month text NOT NULL,
  questions int NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, month)
);
`;

/* add-ons sold on top of a plan (keys are what the app checks) */
const ADDONS = [
  ['ifrs', 'IFRS statements', 'Group IFRS statements page with the Excel and PDF downloads.'],
  ['notes', 'Disclosure notes', 'Group disclosures and the movement notes in the IFRS statements.'],
  ['segments', 'Segment information', 'Each company before and after journals, with the Excel export.'],
  ['comms', 'Management and investor communication', 'The Management and Investors pages.'],
  ['equity', 'Equity accounting', 'Associates and joint ventures accounted for under the equity method.'],
  ['goodwill', 'Goodwill and business combinations', 'Acquisitions during the period: goodwill or a bargain purchase.'],
  ['nci', 'Non-controlling interests', 'Subsidiaries held at less than 100%.'],
  ['ai', 'AI assistant (Yai)', 'Yai answers how to use ConsolX and prepares upload kits (entities, shareholders, chart, journals).'],
];
/* placeholder plans: prices start at nil until set in the admin console */
const TIERS = [
  ['holding', 'Holding — Standard', 5, 1], ['holding', 'Holding — Plus', 15, 1],
  ['firm', 'Firm — Starter', 5, 5], ['firm', 'Firm — Professional', 15, 20], ['firm', 'Firm — Enterprise', 50, 100],
];
const SETTINGS = {
  currency: 'USD',
  annual_discount_pct: 15,
  invoice_prefix: 'CX-',
  next_invoice_no: 1,
  payment_terms_days: 14,
  issuer: { name: 'ConsolX', address: '', email: '', tax_id: '' },
  payment_instructions: 'Bank transfer — details to be completed in the admin console.',
  ai_monthly_questions: 1000,
};

async function migrate(){
  await q(SCHEMA);
  for(const [k, v] of Object.entries(SETTINGS)) await q('INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [k, JSON.stringify(v)]);
  for(const [i, [key, name, desc]] of ADDONS.entries())
    await q('INSERT INTO addons(key, name, description, sort) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING', [key, name, desc, i]);
  const { rows } = await q('SELECT count(*)::int AS n FROM tiers');
  if(!rows[0].n) for(const [i, [kind, name, u, o]] of TIERS.entries())
    await q('INSERT INTO tiers(kind, name, max_users, max_orgs, sort) VALUES ($1,$2,$3,$4,$5)', [kind, name, u, o, i]);
}

async function getSettings(){
  const { rows } = await q('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

module.exports = { pool, q, tx, migrate, getSettings, ADDON_KEYS: ADDONS.map(a => a[0]) };
