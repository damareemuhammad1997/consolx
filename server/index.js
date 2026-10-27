/* ConsolX server: one deployment, many clients.
   - The app (index.html) is served with the signed-in user, their organisations, the add-ons they may use and
     the saved state of the organisation they have open; the app saves that state back (one JSON document per
     organisation, with a version number so two people cannot silently overwrite each other).
   - The administrator (admin.html, /api/admin) creates clients, their organisations and users, sets the plans
     and add-ons, and issues invoices. */
const path = require('path');
const fs = require('fs');
const express = require('express');
const ROOT0 = path.join(__dirname, '..');
/* no database yet (e.g. the first deploy, before PostgreSQL is added): keep serving the app as a single-browser
   app, exactly as before, instead of failing — and say what is missing */
if(!process.env.DATABASE_URL){
  const app0 = express();
  app0.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(ROOT0, 'index.html')));
  app0.get('/admin', (req, res) => res.status(503).type('text').send('Administration needs a database: add PostgreSQL to the service and set DATABASE_URL.'));
  const port = Number(process.env.PORT || 3000);
  app0.listen(port, () => console.warn(`[consolx] DATABASE_URL is not set — serving the single-browser app only (no sign-in, no clients) on ${port}`));
  module.exports = { app: app0 };
  return;
}
const db = require('./db');
const { q, tx } = db;
const auth = require('./auth');
const billing = require('./billing');
const gateways = require('./gateways');
const { assistant } = require('./assistant');

const ROOT = path.join(__dirname, '..');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '80mb' }));
app.use(auth.loadUser);
app.use('/api', auth.csrf);
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); next(); });

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (status, msg) => Object.assign(new Error(msg), { status });
const int = v => { const n = parseInt(v, 10); if(!Number.isFinite(n)) throw bad(400, 'Invalid id.'); return n; };
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);

/* ---------- who may open which organisation ---------- */
async function userOrgs(user){
  const sql = user.is_superadmin
    ? `SELECT o.id, o.name, 'admin' AS role, c.name AS client, c.kind FROM organisations o JOIN clients c ON c.id = o.client_id ORDER BY c.name, o.name`
    : `SELECT o.id, o.name, m.role, c.name AS client, c.kind FROM memberships m JOIN organisations o ON o.id = m.org_id JOIN clients c ON c.id = o.client_id
       WHERE m.user_id = $1 AND o.client_id = $2 ORDER BY o.name`;
  return (await q(sql, user.is_superadmin ? [] : [user.id, user.client_id])).rows;
}
async function orgAccess(user, orgId){
  return (await userOrgs(user)).find(o => o.id === orgId) || null;
}

/* ---------- the app ---------- */
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const LS = new RegExp(String.fromCharCode(0x2028), 'g'), PS = new RegExp(String.fromCharCode(0x2029), 'g');
const js = v => JSON.stringify(v).replace(/</g, '\\u003c').replace(LS, '\\u2028').replace(PS, '\\u2029');
app.get(['/', '/index.html'], wrap(async (req, res) => {
  let boot = { mode: 'server', user: null };
  let state = null;
  if(req.user){
    const u = req.user;
    const orgs = await userOrgs(u);
    let org = orgs.find(o => o.id === u.session_org) || orgs[0] || null;
    let ent = { addons: [] };
    if(org){
      const r = (await q('SELECT state, version, updated_at FROM organisations WHERE id = $1', [org.id])).rows[0];
      state = r.state; org = Object.assign({}, org, { version: r.version, updatedAt: r.updated_at });
      ent = await billing.entitlements(u, org.id);
      if(org.id !== u.session_org) await q('UPDATE sessions SET org_id = $1 WHERE token_hash = $2', [org.id, u.token_hash]);
    }
    boot = { mode: 'server', user: { name: u.name, email: u.email, title: u.title, superadmin: u.is_superadmin, mustChangePassword: u.must_change_password },
      orgs, org, entitlements: ent };
  }
  const inject = `<script>window.CX_SERVER=${js(boot)};window.CX_BOOT_STATE=${js(state)};</script>`;
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(INDEX.replace('<head>', '<head>' + inject));
}));
app.get('/admin', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.type('html').send(ADMIN); });

/* ---------- session ---------- */
app.post('/api/login', wrap(auth.login));
app.post('/api/logout', wrap(async (req, res) => { await auth.destroySession(req, res); res.json({ ok: true }); }));
app.get('/api/me', auth.requireUser, wrap(async (req, res) => {
  const orgs = await userOrgs(req.user);
  res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email, superadmin: req.user.is_superadmin, mustChangePassword: req.user.must_change_password }, orgs, org: req.user.session_org });
}));
app.post('/api/session/org', auth.requireUser, wrap(async (req, res) => {
  const id = int(req.body.orgId);
  if(!(await orgAccess(req.user, id))) throw bad(403, 'You do not have access to that organisation.');
  await q('UPDATE sessions SET org_id = $1 WHERE token_hash = $2', [id, req.user.token_hash]);
  res.json({ ok: true });
}));
app.post('/api/me/password', auth.requireUser, wrap(async (req, res) => {
  const { current, next } = req.body || {};
  const u = (await q('SELECT password_hash FROM users WHERE id = $1', [req.user.id])).rows[0];
  if(!(await auth.checkPassword(current, u.password_hash))) throw bad(401, 'Your current password is not right.');
  const p = auth.passwordProblem(next); if(p) throw bad(400, p);
  await q('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [await auth.hashPassword(next), req.user.id]);
  await q('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [req.user.id, req.user.token_hash]);
  res.json({ ok: true });
}));

/* ---------- an organisation's data ---------- */
app.get('/api/orgs/:id/state', auth.requireUser, wrap(async (req, res) => {
  const id = int(req.params.id);
  if(!(await orgAccess(req.user, id))) throw bad(403, 'You do not have access to that organisation.');
  const r = (await q('SELECT state, version, updated_at FROM organisations WHERE id = $1', [id])).rows[0];
  res.json({ state: r.state, version: r.version, updatedAt: r.updated_at });
}));
app.put('/api/orgs/:id/state', auth.requireUser, wrap(async (req, res) => {
  const id = int(req.params.id);
  const acc = await orgAccess(req.user, id);
  if(!acc) throw bad(403, 'You do not have access to that organisation.');
  const { version, state, reset } = req.body || {};
  if(reset && acc.role !== 'admin') throw bad(403, 'Only an organisation administrator can reset its data.');
  if(state !== null && (typeof state !== 'object' || Array.isArray(state))) throw bad(400, 'Invalid data.');
  const r = await q(`UPDATE organisations SET state = $1, version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $3 AND version = $4 RETURNING version, updated_at`,
    [state === null ? null : JSON.stringify(state), req.user.id, id, Number(version)]);
  if(!r.rows[0]){
    const cur = (await q(`SELECT o.version, o.updated_at, u.name FROM organisations o LEFT JOIN users u ON u.id = o.updated_by WHERE o.id = $1`, [id])).rows[0];
    return res.status(409).json({ error: `${cur.name || 'Someone'} saved changes to this organisation after you opened it.`, version: cur.version, updatedAt: cur.updated_at, by: cur.name });
  }
  res.json({ version: r.rows[0].version, updatedAt: r.rows[0].updated_at });
}));

/* ---------- Yai, the assistant (the "ai" add-on) ---------- */
const yai = assistant({ q, getSettings: db.getSettings, entitlements: billing.entitlements, orgAccess });
app.get('/api/assistant', auth.requireUser, wrap(yai.status));
app.post('/api/assistant', auth.requireUser, wrap(yai.ask));

/* ---------- administration ---------- */
const A = express.Router();
A.use(auth.requireSuper);
const ADDON_KEYS = () => q('SELECT key FROM addons').then(r => r.rows.map(x => x.key));
async function cleanAddons(list){ const ok = await ADDON_KEYS(); return [...new Set((Array.isArray(list) ? list : []).map(String))].filter(k => ok.includes(k)); }
async function tierFor(kind, tierId){
  const t = (await q('SELECT * FROM tiers WHERE id = $1', [int(tierId)])).rows[0];
  if(!t) throw bad(400, 'Choose a plan.');
  if(t.kind !== kind) throw bad(400, `That plan is for ${t.kind === 'firm' ? 'accounting firms' : 'holding companies'}.`);
  return t;
}

A.get('/overview', wrap(async (req, res) => {
  const clients = (await q(`SELECT c.*, t.name AS tier_name, t.max_users, t.max_orgs,
      (SELECT count(*)::int FROM users u WHERE u.client_id = c.id AND u.status = 'active') AS users,
      (SELECT count(*)::int FROM organisations o WHERE o.client_id = c.id) AS orgs,
      (SELECT coalesce(sum(total),0) FROM invoices i WHERE i.client_id = c.id AND i.status = 'issued') AS unpaid
    FROM clients c JOIN tiers t ON t.id = c.tier_id ORDER BY c.name`)).rows;
  const tiers = (await q('SELECT * FROM tiers ORDER BY kind, sort, id')).rows;
  const addons = (await q('SELECT * FROM addons ORDER BY sort')).rows;
  const codes = (await q(`SELECT d.*, (SELECT count(*)::int FROM clients c WHERE c.discount_code = d.code) AS clients FROM discount_codes d ORDER BY d.created_at DESC`)).rows;
  const m = new Date().toISOString().slice(0, 7);
  const yaiUse = (await q(`SELECT o.name AS org, c.name AS client, u.questions, u.input_tokens, u.output_tokens, u.cache_read_tokens
    FROM ai_usage u JOIN organisations o ON o.id = u.org_id JOIN clients c ON c.id = o.client_id WHERE u.month = $1 ORDER BY u.questions DESC`, [m])).rows;
  res.json({ clients, tiers, addons, codes, yai: { enabled: yai.enabled(), month: m, usage: yaiUse }, settings: await db.getSettings(), gateways: gateways.list(), me: { name: req.user.name, email: req.user.email, mustChangePassword: req.user.must_change_password } });
}));

/* a client's discount code: '' or none clears it; otherwise an existing code that is switched on */
async function codeFor(v, current){
  const c = str(v, 40).toUpperCase();
  if(!c) return null;
  if(c === current) return c;
  const d = (await q('SELECT code, active FROM discount_codes WHERE code = $1', [c])).rows[0];
  if(!d) throw bad(400, `There is no discount code ${c}.`);
  if(!d.active) throw bad(400, `Discount code ${c} is switched off.`);
  return d.code;
}
A.post('/clients', wrap(async (req, res) => {
  const b = req.body || {};
  const kind = b.kind === 'holding' ? 'holding' : b.kind === 'firm' ? 'firm' : null;
  if(!kind) throw bad(400, 'Choose accounting firm or holding company.');
  const name = str(b.name); if(!name) throw bad(400, 'Give the client a name.');
  const t = await tierFor(kind, b.tier_id);
  const r = await q(`INSERT INTO clients(name, kind, tier_id, cycle, addons, billing_email, billing_address, notes, discount_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [name, kind, t.id, b.cycle === 'annual' ? 'annual' : 'monthly', await cleanAddons(b.addons), str(b.billing_email), str(b.billing_address, 1000), str(b.notes, 2000), await codeFor(b.discount_code)]);
  res.json(r.rows[0]);
}));
A.get('/clients/:id', wrap(async (req, res) => {
  const id = int(req.params.id);
  const c = await billing.clientWithTier(id); if(!c) throw bad(404, 'Client not found.');
  const orgs = (await q(`SELECT id, name, version, updated_at, created_at, pg_column_size(state) AS bytes FROM organisations WHERE client_id = $1 ORDER BY name`, [id])).rows;
  const users = (await q(`SELECT id, email, name, title, status, must_change_password, last_login_at, created_at FROM users WHERE client_id = $1 ORDER BY name, email`, [id])).rows;
  const mem = (await q(`SELECT m.* FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.client_id = $1`, [id])).rows;
  users.forEach(u => { u.memberships = mem.filter(m => m.user_id === u.id).map(m => ({ org_id: m.org_id, role: m.role })); });
  const invoices = (await q('SELECT * FROM invoices WHERE client_id = $1 ORDER BY period_start DESC, id DESC', [id])).rows;
  res.json({ client: c, usage: await billing.clientUsage(id), orgs, users, invoices });
}));
A.patch('/clients/:id', wrap(async (req, res) => {
  const id = int(req.params.id), b = req.body || {};
  const r = await tx(async c => {
    const cur = (await c.query('SELECT * FROM clients WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if(!cur) throw bad(404, 'Client not found.');
    const kind = b.kind === 'holding' || b.kind === 'firm' ? b.kind : cur.kind;
    const t = await tierFor(kind, b.tier_id != null ? b.tier_id : cur.tier_id);
    const use = await billing.clientUsage(id, c);
    if(use.users > t.max_users || use.orgs > t.max_orgs)
      throw bad(409, `${t.name} includes ${t.max_users} users and ${t.max_orgs} organisations; ${cur.name} has ${use.users} users and ${use.orgs} organisations. Remove some first.`);
    return (await c.query(`UPDATE clients SET name = $2, kind = $3, tier_id = $4, cycle = $5, addons = $6, status = $7, billing_email = $8, billing_address = $9, notes = $10, discount_code = $11 WHERE id = $1 RETURNING *`,
      [id, b.name != null ? (str(b.name) || cur.name) : cur.name, kind, t.id, b.cycle === 'annual' || b.cycle === 'monthly' ? b.cycle : cur.cycle,
       b.addons != null ? await cleanAddons(b.addons) : cur.addons, b.status === 'suspended' || b.status === 'active' ? b.status : cur.status,
       b.billing_email != null ? str(b.billing_email) : cur.billing_email, b.billing_address != null ? str(b.billing_address, 1000) : cur.billing_address,
       b.notes != null ? str(b.notes, 2000) : cur.notes, b.discount_code !== undefined ? await codeFor(b.discount_code, cur.discount_code) : cur.discount_code])).rows[0];
  });
  if(r.status === 'suspended') await q('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE client_id = $1)', [id]);
  res.json(r);
}));

A.post('/clients/:id/orgs', wrap(async (req, res) => {
  const id = int(req.params.id), name = str((req.body || {}).name);
  if(!name) throw bad(400, 'Give the organisation a name.');
  const o = await tx(async c => { await billing.checkLimit(c, id, 'org');
    return (await c.query('INSERT INTO organisations(client_id, name) VALUES ($1,$2) RETURNING id, name, version, created_at', [id, name])).rows[0]; });
  res.json(o);
}));
A.patch('/orgs/:id', wrap(async (req, res) => {
  const name = str((req.body || {}).name); if(!name) throw bad(400, 'Give the organisation a name.');
  const r = await q('UPDATE organisations SET name = $2 WHERE id = $1 RETURNING id, name', [int(req.params.id), name]);
  if(!r.rows[0]) throw bad(404, 'Organisation not found.');
  res.json(r.rows[0]);
}));
A.delete('/orgs/:id', wrap(async (req, res) => {
  const id = int(req.params.id);
  const o = (await q('SELECT name FROM organisations WHERE id = $1', [id])).rows[0]; if(!o) throw bad(404, 'Organisation not found.');
  if(str((req.body || {}).confirm) !== o.name) throw bad(400, 'Type the organisation’s name to confirm deleting it and all its data.');
  await q('DELETE FROM organisations WHERE id = $1', [id]);
  res.json({ ok: true });
}));

async function setMemberships(c, userId, clientId, list){
  const orgs = (await c.query('SELECT id FROM organisations WHERE client_id = $1', [clientId])).rows.map(r => r.id);
  await c.query('DELETE FROM memberships WHERE user_id = $1', [userId]);
  for(const m of (Array.isArray(list) ? list : [])){
    const oid = int(m.org_id); if(!orgs.includes(oid)) throw bad(400, 'A user can only be given organisations of their own client.');
    await c.query('INSERT INTO memberships(user_id, org_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [userId, oid, m.role === 'admin' ? 'admin' : 'user']);
  }
}
A.post('/clients/:id/users', wrap(async (req, res) => {
  const id = int(req.params.id), b = req.body || {};
  const email = str(b.email).toLowerCase();
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad(400, 'Enter a valid e-mail address.');
  let pw = b.password ? String(b.password) : null, generated = false;
  if(pw){ const p = auth.passwordProblem(pw); if(p) throw bad(400, p); } else { pw = auth.randomPassword(); generated = true; }
  const hash = await auth.hashPassword(pw);
  const u = await tx(async c => {
    await billing.checkLimit(c, id, 'user');
    if((await c.query('SELECT 1 FROM users WHERE lower(email) = $1', [email])).rows[0]) throw bad(409, 'A user with that e-mail already exists.');
    const r = (await c.query(`INSERT INTO users(email, name, title, password_hash, client_id, must_change_password) VALUES ($1,$2,$3,$4,$5,true) RETURNING id, email, name, title`,
      [email, str(b.name), str(b.title), hash, id])).rows[0];
    await setMemberships(c, r.id, id, b.memberships);
    return r;
  });
  res.json(Object.assign(u, { password: pw, generated }));
}));
A.patch('/users/:id', wrap(async (req, res) => {
  const id = int(req.params.id), b = req.body || {};
  const r = await tx(async c => {
    const u = (await c.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if(!u || u.is_superadmin) throw bad(404, 'User not found.');
    const status = b.status === 'disabled' || b.status === 'active' ? b.status : u.status;
    if(status === 'active' && u.status !== 'active') await billing.checkLimit(c, u.client_id, 'user');
    const row = (await c.query('UPDATE users SET name = $2, title = $3, status = $4 WHERE id = $1 RETURNING id, email, name, title, status',
      [id, b.name != null ? str(b.name) : u.name, b.title != null ? str(b.title) : u.title, status])).rows[0];
    if(b.memberships) await setMemberships(c, id, u.client_id, b.memberships);
    if(status !== 'active') await c.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    return row;
  });
  res.json(r);
}));
A.post('/users/:id/reset-password', wrap(async (req, res) => {
  const id = int(req.params.id), pw = auth.randomPassword();
  const r = await q('UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1 AND NOT is_superadmin RETURNING email', [id, await auth.hashPassword(pw)]);
  if(!r.rows[0]) throw bad(404, 'User not found.');
  await q('DELETE FROM sessions WHERE user_id = $1', [id]);
  res.json({ email: r.rows[0].email, password: pw });
}));

/* plans and add-ons */
const price = v => { const n = Number(v); if(!Number.isFinite(n) || n < 0) throw bad(400, 'Prices must be zero or more.'); return Math.round(n * 100) / 100; };
const count = v => { const n = parseInt(v, 10); if(!(n >= 1)) throw bad(400, 'Limits must be at least 1.'); return n; };
A.post('/tiers', wrap(async (req, res) => {
  const b = req.body || {}; const kind = b.kind === 'holding' ? 'holding' : 'firm';
  const maxOrgs = kind === 'holding' ? 1 : count(b.max_orgs);
  const r = await q('INSERT INTO tiers(kind, name, max_users, max_orgs, price_monthly, sort) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [kind, str(b.name) || 'New plan', count(b.max_users), maxOrgs, price(b.price_monthly || 0), parseInt(b.sort, 10) || 99]);
  res.json(r.rows[0]);
}));
A.patch('/tiers/:id', wrap(async (req, res) => {
  const id = int(req.params.id), b = req.body || {};
  const t = (await q('SELECT * FROM tiers WHERE id = $1', [id])).rows[0]; if(!t) throw bad(404, 'Plan not found.');
  const maxU = b.max_users != null ? count(b.max_users) : t.max_users;
  const maxO = t.kind === 'holding' ? 1 : (b.max_orgs != null ? count(b.max_orgs) : t.max_orgs);
  const over = (await q(`SELECT c.name FROM clients c WHERE c.tier_id = $1 AND ((SELECT count(*) FROM users u WHERE u.client_id = c.id AND u.status = 'active') > $2
      OR (SELECT count(*) FROM organisations o WHERE o.client_id = c.id) > $3)`, [id, maxU, maxO])).rows;
  if(over.length) throw bad(409, `These clients already use more than the new limits: ${over.map(x => x.name).join(', ')}.`);
  const r = await q('UPDATE tiers SET name = $2, max_users = $3, max_orgs = $4, price_monthly = $5, active = $6 WHERE id = $1 RETURNING *',
    [id, b.name != null ? (str(b.name) || t.name) : t.name, maxU, maxO, b.price_monthly != null ? price(b.price_monthly) : t.price_monthly, b.active != null ? !!b.active : t.active]);
  res.json(r.rows[0]);
}));
A.patch('/addons/:key', wrap(async (req, res) => {
  const b = req.body || {};
  const a = (await q('SELECT * FROM addons WHERE key = $1', [str(req.params.key)])).rows[0]; if(!a) throw bad(404, 'Add-on not found.');
  const r = await q('UPDATE addons SET name = $2, description = $3, price_monthly = $4, active = $5 WHERE key = $1 RETURNING *',
    [a.key, b.name != null ? (str(b.name) || a.name) : a.name, b.description != null ? str(b.description, 500) : a.description,
     b.price_monthly != null ? price(b.price_monthly) : a.price_monthly, b.active != null ? !!b.active : a.active]);
  res.json(r.rows[0]);
}));
/* discount codes */
A.post('/codes', wrap(async (req, res) => {
  const b = req.body || {};
  const code = str(b.code, 40).toUpperCase();
  if(!/^[A-Z0-9_-]{3,40}$/.test(code)) throw bad(400, 'A code is 3 to 40 letters, numbers, - or _.');
  const pct = Number(b.percent); if(!(pct > 0 && pct <= 100)) throw bad(400, 'The discount is more than 0 and at most 100%.');
  const until = str(b.valid_until, 10) || null; if(until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw bad(400, 'Valid until is a date.');
  if((await q('SELECT 1 FROM discount_codes WHERE code = $1', [code])).rows[0]) throw bad(409, `Code ${code} already exists.`);
  res.json((await q('INSERT INTO discount_codes(code, percent, description, valid_until) VALUES ($1,$2,$3,$4) RETURNING *', [code, pct, str(b.description, 200), until])).rows[0]);
}));
A.patch('/codes/:code', wrap(async (req, res) => {
  const b = req.body || {};
  const d = (await q('SELECT * FROM discount_codes WHERE code = $1', [str(req.params.code, 40).toUpperCase()])).rows[0]; if(!d) throw bad(404, 'Code not found.');
  const until = b.valid_until !== undefined ? (str(b.valid_until, 10) || null) : d.valid_until;
  if(until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw bad(400, 'Valid until is a date.');
  res.json((await q('UPDATE discount_codes SET description = $2, valid_until = $3, active = $4 WHERE code = $1 RETURNING *',
    [d.code, b.description != null ? str(b.description, 200) : d.description, until, b.active != null ? !!b.active : d.active])).rows[0]);
}));
A.put('/settings', wrap(async (req, res) => {
  const b = req.body || {}, set = {};
  if(b.currency != null){ const c = str(b.currency, 3).toUpperCase(); if(!/^[A-Z]{3}$/.test(c)) throw bad(400, 'Currency is a three-letter code.'); set.currency = c; }
  if(b.annual_discount_pct != null){ const n = Number(b.annual_discount_pct); if(!(n >= 0 && n <= 100)) throw bad(400, 'The annual discount is between 0 and 100%.'); set.annual_discount_pct = n; }
  if(b.invoice_prefix != null) set.invoice_prefix = str(b.invoice_prefix, 12);
  if(b.payment_terms_days != null){ const n = parseInt(b.payment_terms_days, 10); if(!(n >= 0 && n <= 365)) throw bad(400, 'Payment terms are 0 to 365 days.'); set.payment_terms_days = n; }
  if(b.payment_instructions != null) set.payment_instructions = str(b.payment_instructions, 2000);
  if(b.ai_monthly_questions != null){ const n = parseInt(b.ai_monthly_questions, 10); if(!(n >= 1 && n <= 1000000)) throw bad(400, 'Yai questions a month: a whole number from 1.'); set.ai_monthly_questions = n; }
  if(b.issuer != null) set.issuer = { name: str(b.issuer.name), address: str(b.issuer.address, 1000), email: str(b.issuer.email), tax_id: str(b.issuer.tax_id) };
  for(const [k, v] of Object.entries(set)) await q('UPDATE settings SET value = $2 WHERE key = $1', [k, JSON.stringify(v)]);
  res.json(await db.getSettings());
}));

/* invoices */
A.get('/invoices', wrap(async (req, res) => {
  res.json((await q(`SELECT i.*, c.name AS client FROM invoices i JOIN clients c ON c.id = i.client_id ORDER BY i.issued_at DESC, i.id DESC LIMIT 500`)).rows);
}));
A.post('/invoices/quote', wrap(async (req, res) => { const b = req.body || {}; res.json(await billing.quote(int(b.client_id), b.cycle, str(b.start, 10))); }));
A.post('/invoices', wrap(async (req, res) => { const b = req.body || {}; res.json(await billing.issueInvoice(int(b.client_id), b.cycle, str(b.start, 10), str(b.notes, 1000))); }));
A.post('/invoices/run', wrap(async (req, res) => { const b = req.body || {}; res.json(await billing.runBilling(b.cycle === 'annual' ? 'annual' : 'monthly', str(b.start, 10))); }));
A.post('/invoices/:id/paid', wrap(async (req, res) => { const b = req.body || {}; res.json(await billing.markPaid(int(req.params.id), str(b.ref), b.gateway)); }));
A.post('/invoices/:id/void', wrap(async (req, res) => res.json(await billing.voidInvoice(int(req.params.id)))));
app.use('/api/admin', A);

/* a printable invoice (the browser's print dialog saves it as PDF) */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
app.get('/invoice/:id', auth.requireSuper, wrap(async (req, res) => {
  const i = (await q(`SELECT i.*, c.name AS client, c.billing_address, c.billing_email FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = $1`, [int(req.params.id)])).rows[0];
  if(!i) throw bad(404, 'Invoice not found.');
  const s = await db.getSettings(), g = gateways.get(i.gateway) || gateways.get('manual');
  const m = v => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const d = v => new Date(v).toISOString().slice(0, 10);
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice ${esc(i.number)}</title>
<style>body{font:14px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d2433;background:#fff;margin:0;padding:32px}main{max-width:780px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:18px 0}th,td{padding:8px 6px;border-bottom:1px solid #e3e7ee;text-align:left;vertical-align:top}
td.n,th.n{text-align:right;white-space:nowrap}.tot td{font-weight:700;border-bottom:2px solid #1d2433}.row{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap}
.muted{color:#5b6475}.stamp{display:inline-block;padding:3px 10px;border-radius:12px;font-weight:700;font-size:12px;background:${i.status === 'paid' ? '#e3f6ea;color:#11683a' : i.status === 'void' ? '#f2f2f2;color:#666' : '#fff4e0;color:#8a5309'}}
pre{white-space:pre-wrap;font:inherit;margin:0}@media print{body{padding:0}.noprint{display:none}}</style></head><body><main>
<p class="noprint"><button onclick="print()">Print or save as PDF</button></p>
<div class="row"><div><h1>${esc(s.issuer && s.issuer.name || 'ConsolX')}</h1><pre class="muted">${esc(s.issuer && s.issuer.address || '')}</pre><div class="muted">${esc(s.issuer && s.issuer.email || '')}${s.issuer && s.issuer.tax_id ? ' · Tax ID ' + esc(s.issuer.tax_id) : ''}</div></div>
<div style="text-align:right"><h1>Invoice ${esc(i.number)}</h1><div>Issued ${d(i.issued_at)} · due ${d(i.due_date)}</div><div><span class="stamp">${esc(i.status.toUpperCase())}</span></div></div></div>
<div style="margin-top:22px"><strong>Bill to</strong><div>${esc(i.client)}</div><pre class="muted">${esc(i.billing_address)}</pre><div class="muted">${esc(i.billing_email)}</div></div>
<p>Period ${d(i.period_start)} to ${d(i.period_end)} (${i.cycle === 'annual' ? 'annual' : 'monthly'} billing)</p>
<table><thead><tr><th>Description</th><th class="n">Months</th><th class="n">Monthly price</th><th class="n">Amount (${esc(i.currency)})</th></tr></thead><tbody>
${i.lines.map(l => `<tr><td>${esc(l.description)}</td><td class="n">${l.qty}</td><td class="n">${m(l.unit)}</td><td class="n">${m(l.amount)}</td></tr>`).join('')}
<tr><td colspan="3">Subtotal</td><td class="n">${m(i.subtotal)}</td></tr>
${(i.discounts && i.discounts.length ? i.discounts : (Number(i.discount) ? [{ label: 'Annual billing discount', amount: i.discount }] : [])).map(x => `<tr><td colspan="3">${esc(x.label)}</td><td class="n">(${m(x.amount)})</td></tr>`).join('')}
<tr class="tot"><td colspan="3">Total due</td><td class="n">${esc(i.currency)} ${m(i.total)}</td></tr></tbody></table>
${i.status === 'paid' && Number(i.total) === 0 ? '<p>No charge.</p>' : i.status === 'paid' ? `<p>Paid on ${d(i.paid_at)}${i.paid_ref ? ' · reference ' + esc(i.paid_ref) : ''} (${esc(g.name)}).</p>` : `<h3>How to pay</h3><pre>${esc(g.instructions(i, s))}</pre>`}
${i.notes ? `<p class="muted">${esc(i.notes)}</p>` : ''}</main></body></html>`);
}));

/* errors: JSON for the API, a short page otherwise */
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  if(status >= 500) console.error(err);
  const msg = status >= 500 ? 'Something went wrong on the server.' : err.message;
  if(req.path.startsWith('/api/')) return res.status(status).json({ error: msg });
  res.status(status).type('text').send(msg);
});

async function start(){
  await db.migrate();
  await auth.bootstrapAdmin();
  setInterval(() => q('DELETE FROM sessions WHERE expires_at < now()').catch(() => {}), 3600e3).unref();
  const port = Number(process.env.PORT || 3000);
  return new Promise(r => { const s = app.listen(port, () => { console.log(`[consolx] listening on ${port}`); r(s); }); });
}
if(require.main === module) start().catch(e => { console.error(e); process.exit(1); });
module.exports = { app, start, yai };
