/* Plans, add-ons, limits and invoices.
   A client (accounting firm or holding company) is on one plan ("tier"): the plan includes a number of users and
   organisations and has a monthly price; add-ons are priced monthly on top. Annual billing is twelve months less
   the annual discount, then less the client's discount code if it has a valid one. Limits are hard: a user or organisation beyond the plan is refused until the plan is raised.
   Payment goes through a gateway (server/gateways): 'manual' (bank transfer, marked paid by the administrator)
   today; PayPal and others plug in behind the same interface. */
const { q, tx, getSettings } = require('./db');
const gateways = require('./gateways');

const money = v => Math.round(Number(v || 0) * 100) / 100;

async function clientUsage(clientId, db = { query: q }){
  const run = (t, p) => (db.query ? db.query(t, p) : q(t, p));
  const u = await run(`SELECT count(*)::int AS n FROM users WHERE client_id = $1 AND status = 'active'`, [clientId]);
  const o = await run('SELECT count(*)::int AS n FROM organisations WHERE client_id = $1', [clientId]);
  return { users: u.rows[0].n, orgs: o.rows[0].n };
}
async function clientWithTier(clientId, db){
  const run = (t, p) => (db ? db.query(t, p) : q(t, p));
  const { rows } = await run(`SELECT c.*, t.name AS tier_name, t.max_users, t.max_orgs, t.price_monthly AS tier_price, t.kind AS tier_kind
    FROM clients c JOIN tiers t ON t.id = c.tier_id WHERE c.id = $1`, [clientId]);
  return rows[0] || null;
}
/* refuse what the plan does not include (called inside the creating transaction) */
async function checkLimit(db, clientId, what){
  const c = await clientWithTier(clientId, db);
  if(!c) throw Object.assign(new Error('Client not found.'), { status: 404 });
  await db.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [clientId]);
  const use = await clientUsage(clientId, db);
  if(what === 'user' && use.users >= c.max_users)
    throw Object.assign(new Error(`${c.name}'s plan (${c.tier_name}) includes ${c.max_users} user${c.max_users === 1 ? '' : 's'} — raise the plan to add another.`), { status: 409 });
  if(what === 'org' && use.orgs >= c.max_orgs)
    throw Object.assign(new Error(`${c.name}'s plan (${c.tier_name}) includes ${c.max_orgs} organisation${c.max_orgs === 1 ? '' : 's'} — raise the plan to add another.`), { status: 409 });
  return c;
}
/* the add-ons an organisation's users get: its client's, or every add-on for the administrator */
async function entitlements(user, orgId){
  const all = (await q('SELECT key FROM addons')).rows.map(r => r.key);
  if(user.is_superadmin) return { addons: all, all: true };
  const { rows } = await q(`SELECT c.addons, c.kind, t.name AS tier FROM organisations o JOIN clients c ON c.id = o.client_id JOIN tiers t ON t.id = c.tier_id WHERE o.id = $1`, [orgId]);
  if(!rows[0]) return { addons: [] };
  return { addons: rows[0].addons.filter(k => all.includes(k)), tier: rows[0].tier, kind: rows[0].kind };
}

function periodOf(cycle, start){
  const d = new Date(start + 'T00:00:00Z');
  if(isNaN(d)) throw Object.assign(new Error('Invalid period start.'), { status: 400 });
  const end = new Date(d); end.setUTCMonth(end.getUTCMonth() + (cycle === 'annual' ? 12 : 1)); end.setUTCDate(end.getUTCDate() - 1);
  const iso = x => x.toISOString().slice(0, 10);
  return { start: iso(d), end: iso(end) };
}
/* the lines of a client's invoice for one period, from its current plan and add-ons */
async function quote(clientId, cycle, start){
  const s = await getSettings();
  const c = await clientWithTier(clientId);
  if(!c) throw Object.assign(new Error('Client not found.'), { status: 404 });
  cycle = cycle || c.cycle;
  const months = cycle === 'annual' ? 12 : 1;
  const per = periodOf(cycle, start);
  const use = await clientUsage(clientId);
  const lines = [{ kind: 'plan', description: `${c.tier_name} — up to ${c.max_users} users and ${c.max_orgs} organisation${c.max_orgs === 1 ? '' : 's'} (in use: ${use.users} users, ${use.orgs} organisation${use.orgs === 1 ? '' : 's'})`,
    qty: months, unit: money(c.tier_price), amount: money(c.tier_price * months) }];
  if(c.addons.length){
    const { rows } = await q('SELECT key, name, price_monthly FROM addons WHERE key = ANY($1) ORDER BY sort', [c.addons]);
    rows.forEach(a => lines.push({ kind: 'addon', key: a.key, description: `Add-on: ${a.name}`, qty: months, unit: money(a.price_monthly), amount: money(a.price_monthly * months) }));
  }
  const subtotal = money(lines.reduce((t, l) => t + l.amount, 0));
  const discounts = [];
  const pct = Number(s.annual_discount_pct || 0);
  if(cycle === 'annual' && pct > 0) discounts.push({ label: `Annual billing discount (${pct}%)`, amount: money(subtotal * pct / 100) });
  let codeNote = null;
  if(c.discount_code){
    const d = (await q('SELECT * FROM discount_codes WHERE code = $1', [c.discount_code])).rows[0];
    if(d && d.active && (!d.valid_until || per.start <= d.valid_until)){
      const base = subtotal - discounts.reduce((t, x) => t + x.amount, 0);
      discounts.push({ label: `Discount code ${d.code} (${Number(d.percent)}%)` + (d.description ? ' — ' + d.description : ''), amount: money(base * Number(d.percent) / 100), code: d.code });
    } else codeNote = d ? `Discount code ${d.code} not applied: ${!d.active ? 'it is switched off' : 'it expired on ' + d.valid_until}.` : null;
  }
  const discount = money(discounts.reduce((t, x) => t + x.amount, 0));
  return { client: c, cycle, period: per, currency: s.currency, lines, subtotal, discounts, discount, total: money(Math.max(0, subtotal - discount)), usage: use, codeNote };
}
async function issueInvoice(clientId, cycle, start, notes){
  const Q = await quote(clientId, cycle, start);
  return tx(async db => {
    const dup = await db.query(`SELECT number FROM invoices WHERE client_id = $1 AND period_start = $2 AND cycle = $3 AND status <> 'void'`, [clientId, Q.period.start, Q.cycle]);
    if(dup.rows[0]) throw Object.assign(new Error(`Invoice ${dup.rows[0].number} already covers this period.`), { status: 409 });
    const s = (await db.query(`SELECT key, value FROM settings WHERE key IN ('invoice_prefix','next_invoice_no','payment_terms_days') FOR UPDATE`)).rows;
    const S = Object.fromEntries(s.map(r => [r.key, r.value]));
    const n = Number(S.next_invoice_no || 1);
    const number = String(S.invoice_prefix || '') + String(n).padStart(5, '0');
    await db.query(`UPDATE settings SET value = $1 WHERE key = 'next_invoice_no'`, [JSON.stringify(n + 1)]);
    /* nothing to pay (a 100% discount): recorded as paid, "No charge" */
    const free = Q.total <= 0;
    const { rows } = await db.query(`INSERT INTO invoices(client_id, number, period_start, period_end, cycle, currency, lines, subtotal, discount, discounts, total, due_date, notes, status, paid_at, paid_ref)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, current_date + $12::int, $13, $14, $15, $16) RETURNING *`,
      [clientId, number, Q.period.start, Q.period.end, Q.cycle, Q.currency, JSON.stringify(Q.lines), Q.subtotal, Q.discount, JSON.stringify(Q.discounts), Q.total,
       Number(S.payment_terms_days || 14), notes || '', free ? 'paid' : 'issued', free ? new Date() : null, free ? 'No charge' : '']);
    return rows[0];
  });
}
/* every active client on the cycle, for the period that starts on `start` (an existing invoice is skipped) */
async function runBilling(cycle, start){
  const { rows } = await q(`SELECT id, name FROM clients WHERE status = 'active' AND cycle = $1 ORDER BY id`, [cycle]);
  const out = [];
  for(const c of rows){
    try {
      const Q = await quote(c.id, cycle, start);
      if(Q.total <= 0){ out.push({ client: c.name, skipped: 'no charge (' + (Q.discounts.map(d => d.label).join(', ') || 'nil prices') + ')' }); continue; }
      const inv = await issueInvoice(c.id, cycle, start); out.push({ client: c.name, number: inv.number, total: inv.total }); }
    catch(e){ out.push({ client: c.name, skipped: e.message }); }
  }
  return out;
}
async function markPaid(id, ref, gateway){
  const g = gateways.get(gateway || 'manual');
  if(!g) throw Object.assign(new Error('Unknown payment method.'), { status: 400 });
  const { rows } = await q(`UPDATE invoices SET status = 'paid', paid_at = now(), paid_ref = $2, gateway = $3 WHERE id = $1 AND status = 'issued' RETURNING *`, [id, ref || '', g.key]);
  if(!rows[0]) throw Object.assign(new Error('Only an issued invoice can be marked paid.'), { status: 409 });
  return rows[0];
}
async function voidInvoice(id){
  const { rows } = await q(`UPDATE invoices SET status = 'void' WHERE id = $1 AND status = 'issued' RETURNING *`, [id]);
  if(!rows[0]) throw Object.assign(new Error('Only an issued invoice can be voided.'), { status: 409 });
  return rows[0];
}

module.exports = { clientUsage, clientWithTier, checkLimit, entitlements, quote, issueInvoice, runBilling, markPaid, voidInvoice, periodOf, money };
