/* Yai, the ConsolX assistant (the "ai" add-on), answering with Claude:
     how to use ConsolX — the Admin and User views, page by page, in the order a group is set up and consolidated
     the upload kits — entities, shareholders, chart of accounts, entity packs, intragroup templates, journal
                      entries: what goes in each column, and, for the CSV kits, a ready-to-import file drafted with
                      the organisation's own entity and account codes
   It sees a summary of the open organisation (entities, ownership, periods, chart of accounts) so its answers and
   files use real codes; it cannot change anything. Questions are counted per organisation and month against the
   allowance (Settings › AI questions a month); nothing is kept but the count.
   ANTHROPIC_API_KEY switches it on; CONSOLX_AI_MODEL changes the model. */
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const MAX_Q = 2000, MAX_TURNS = 10, PER_MINUTE = 8;
const MAX_ENTITIES = 400, MAX_ACCOUNTS = 1500;
const GUIDE = (() => { try { return fs.readFileSync(path.join(__dirname, '..', 'docs', 'guide.md'), 'utf8'); } catch(e){ return ''; } })();
const month = () => new Date().toISOString().slice(0, 7);

/* Where things are, for "how do I …" questions; keep in step with CX_NAV_TREE and the user menu in index.html */
const APP_MAP = `ConsolX has two views of an organisation (a group's consolidation), switched from the user menu.

The top bar: the reporting period selector, "All changes saved", and the user menu (initials, top right): organisation switcher (when the user has several), Admin view / User view (organisation admins), Change password, Administration (ConsolX administrator only), Sign out. The round Yai bubble sits at the bottom right.

Admin view (organisation admins):
- Entities › Entity profile: the companies (New, Import CSV, Export); code, legal name, country, currency, local GAAP, year-end month, contacts.
- Entities › Ownership register: who holds each company and from which date (Import CSV); relationship (control, joint control, joint operation, significant influence, none) with a reason when it differs from the default.
- Entities › Structure chart: the group tree.
- Chart of accounts: Financial statements, Mapping accounts, Captions, Categories, Activity log; tabs Balance sheet, Profit or loss, Other comprehensive income, Cash flows; Import workbook (Excel or CSV; the import window downloads the current chart as the template).
- Reporting period: New reporting period; the period wizard: 1 Groups, 2 Structure movements (acquisitions, disposals, changes in holding, validated per group), 3 Consolidation summary (read only), 4 Foreign currency (opening, average, closing rates).

User view (everyone):
- Home: the period's progress.
- Packs › Financial packs: per entity, download the pack, upload it back, see what is missing; packs are per reporting period.
- Intragroup › Financials and Intragroup › Cash flows: intercompany balances and cash flows by IC Code, split across counterparties (Export all templates, upload, live check).
- Reports › Financial reports (each entity's own statements and cash flows) and Reports › IFRS Financial Statements.
- Consolidation › Group balance sheet, Group P&L, Group cash flow, Group disclosures, Group IFRS statements, Segment information, Group journal entries (New journal entry, Import, Export).
- Communication › Management and Investors.
- Currency exchange rates (from the period's step 4, read only).

Add-ons the client may not have (the page then shows a lock naming it; the ConsolX administrator adds it): IFRS statements, Disclosure notes, Segment information, Management and investor communication, Equity accounting, Goodwill and business combinations, Non-controlling interests, AI assistant (Yai).

Accounts: the ConsolX administrator creates clients, organisations and users at /admin; an organisation admin cannot add users. Forgotten password: the administrator resets it.`;

const RULES = `Answer in the language of the question, briefly and plainly, as an experienced consolidation colleague would. Write plain text, shown as it is: short paragraphs, and "- " or "1. " for lists; no Markdown (no headings, tables, bold, code fences or links).
Use the reference material in this prompt first. For IFRS questions beyond it (IFRS 10, IFRS 3, IAS 21, IAS 28, IAS 7 …), answer from what you know, say so, and suggest checking with the group's auditors where it matters.
Never invent a menu, a column, a rule, a figure, an entity code or an account code: use the codes in the organisation summary. If something is not there, or you are not sure, say so.
For "how do I" questions, give the path through the menus (e.g. Admin › Entities › Ownership register › Import), then numbered steps; only menus the map or the guide names.
You cannot see or change the organisation's figures or settings beyond the summary below; point to the page that shows them.

Preparing upload files: when the person asks for an importable CSV (entities, shareholders, chart of accounts CSV, journal entries), first make sure you have what you need: ask briefly for anything missing rather than guessing amounts, dates or percentages. Then give one short line of explanation and the file, exactly in this form, on lines of its own:
<file name="journal_entries.csv">
je_number,category,...
...
</file>
The file holds only the CSV: the exact header of the guide, one row per line, comma separated, values with a comma in double quotes, dates DD/MM/YYYY, plain numbers. Use the organisation's real entity and account codes. After the file, list in a few lines what to check before importing and where to import it. Excel kits (entity packs, intragroup templates, the chart workbook) come from their pages: explain how to fill them, do not write them as files.`;

/* What Yai knows of the open organisation: enough to name real codes; no figures */
function orgSummary(state, orgName){
  const S = state || {};
  const ents = Array.isArray(S.entities) ? S.entities : [];
  const byId = new Map(ents.map(e => [e.id, e]));
  const others = new Map((Array.isArray(S.nonEntityShareholders) ? S.nonEntityShareholders : []).map(x => [x.id, x]));
  const out = ['Organisation: ' + orgName];
  out.push('Group currency: ' + (S.groupCurrency || 'not set'));
  const pers = Array.isArray(S.reportingPeriods) ? S.reportingPeriods : [];
  const act = pers.find(p => p.id === S.activePeriodId);
  out.push('Reporting periods: ' + (pers.length ? pers.map(p => `${p.label} (${p.startDate} to ${p.endDate}${p.locked ? ', locked' : ''})`).join('; ') : 'none yet'));
  if(act) out.push('Selected period: ' + act.label);
  out.push('', `Entities (${ents.length}): code | legal name | country | currency`);
  ents.slice(0, MAX_ENTITIES).forEach(e => out.push(`${e.code} | ${e.legalName || ''} | ${e.country || ''} | ${e.currency || ''}`));
  if(ents.length > MAX_ENTITIES) out.push(`… and ${ents.length - MAX_ENTITIES} more`);
  const sh = (Array.isArray(S.shareholdings) ? S.shareholdings : []).filter(r => r && r.effectiveTo == null);
  if(sh.length){
    out.push('', 'Ownership in force (latest split): entity ← holder pct% (since)');
    sh.slice(0, MAX_ENTITIES * 3).forEach(r => {
      const e = byId.get(r.entityId); const ref = r.shareholderRef || {};
      const holder = ref.kind === 'entity' ? (byId.get(ref.id) || {}).code : (others.get(ref.id) || {}).name;
      if(e && holder) out.push(`${e.code} ← ${holder}${ref.kind === 'entity' ? '' : ' (' + ref.kind + ')'} ${r.percentage}% (${r.effectiveFrom || ''})`);
    });
  }
  const acc = Array.isArray(S.accounts) ? S.accounts : [];
  const caps = new Map((Array.isArray(S.fsCaptions) ? S.fsCaptions : []).map(c => [c.id, c]));
  const code = id => { const e = byId.get(id); return e ? e.code : ''; };
  out.push('', `Chart of accounts (${acc.length}): code | name | statement line${acc.some(a => a.ic) ? ' | intercompany with' : ''}`);
  acc.slice(0, MAX_ACCOUNTS).forEach(a => out.push(`${a.code} | ${a.name}` + ((caps.get(a.captionId) || {}).name ? ' | ' + caps.get(a.captionId).name : '') + (a.ic ? ' | IC ' + ((a.cps || []).map(code).filter(Boolean).join(';') || 'any') : '')));
  if(acc.length > MAX_ACCOUNTS) out.push(`… and ${acc.length - MAX_ACCOUNTS} more`);
  const cf = Array.isArray(S.cfAccounts) ? S.cfAccounts : [];
  if(cf.length){ out.push('', `Cash flow accounts (${cf.length}): code | name`); cf.slice(0, MAX_ACCOUNTS).forEach(a => out.push(`${a.code} | ${a.name}`)); }
  if(Array.isArray(S.jeCategories) && S.jeCategories.length) out.push('', 'Journal entry categories: ' + S.jeCategories.join(', '));
  const je = Array.isArray(S.journalEntries) ? S.journalEntries.filter(j => !act || j.periodId === act.id) : [];
  if(act) out.push(`Group journal entries in ${act.label}: ${je.length} (last number ${je.reduce((m, j) => Math.max(m, +j.number || 0), 0)})`);
  if(act && S.financialsUploads && typeof S.financialsUploads === 'object'){
    const up = new Set(Object.keys(S.financialsUploads).filter(k => k.startsWith(act.id + '-')).map(k => +k.slice(String(act.id).length + 1)));
    const missing = ents.filter(e => !up.has(e.id)).map(e => e.code);
    out.push(`Financial packs uploaded in ${act.label}: ${up.size}` + (missing.length ? '; not uploaded: ' + missing.slice(0, 80).join(', ') + (missing.length > 80 ? ' …' : '') : ''));
  }
  return out.join('\n');
}

function assistant({ q, getSettings, entitlements, orgAccess, env = process.env, clientFactory, log = console.error }){
  let client = null;
  const enabled = () => !!(client || clientFactory || env.ANTHROPIC_API_KEY);
  const api = () => client || (client = clientFactory ? clientFactory() : new Anthropic());
  const MODEL = env.CONSOLX_AI_MODEL || 'claude-opus-5-5';
  const hits = new Map();
  const fail = (res, status, error) => res.status(status).json({ error });

  async function allowance(){ const s = await getSettings(); return Number(s.ai_monthly_questions) > 0 ? Number(s.ai_monthly_questions) : 1000; }
  async function used(orgId){
    const r = (await q('SELECT questions FROM ai_usage WHERE org_id = $1 AND month = $2', [orgId, month()])).rows[0];
    return r ? r.questions : 0;
  }
  /* the organisation the person asks about, if they may, and whether its client has the add-on */
  async function access(req, res){
    const orgId = parseInt((req.body && req.body.orgId) || req.query.orgId || req.user.session_org, 10);
    const org = Number.isFinite(orgId) ? await orgAccess(req.user, orgId) : null;
    if(!org){ fail(res, 403, 'Open an organisation first.'); return null; }
    const ent = await entitlements(req.user, org.id);
    if(!ent.addons.includes('ai')){ fail(res, 403, 'Yai is an add-on: ask your ConsolX administrator to add the AI assistant to your plan.'); return null; }
    return org;
  }

  async function status(req, res){
    const org = await access(req, res); if(!org) return;
    res.json({ enabled: enabled(), usage: { questions: await used(org.id), allowance: await allowance() } });
  }

  async function ask(req, res){
    if(!enabled()) return fail(res, 503, 'Yai is not switched on on this server yet.');
    const org = await access(req, res); if(!org) return;
    const b = req.body || {};
    const qn = String(b.question || '').trim();
    if(!qn) return fail(res, 400, 'Ask a question.');
    if(qn.length > MAX_Q) return fail(res, 400, 'Keep the question under 2,000 characters.');
    const where = String(b.where || '').replace(/[^\w ›&/,.'()-]/g, '').slice(0, 80).trim(); // the page the person is on
    const view = b.view === 'admin' && org.role === 'admin' ? 'Admin view (organisation admin)' : org.role === 'admin' ? 'User view (organisation admin)' : 'User view (user)';
    const now = Date.now(); const w = hits.get(req.user.id) || { t: now, n: 0 };
    if(now - w.t > 60e3){ w.t = now; w.n = 0; } w.n++; hits.set(req.user.id, w);
    if(w.n > PER_MINUTE) return fail(res, 429, 'A few questions at a time: try again in a minute.');
    const cap = await allowance();
    if(await used(org.id) >= cap) return fail(res, 429, `This month's ${cap} questions have been used; Yai is back on the 1st.`);

    const st = (await q('SELECT state FROM organisations WHERE id = $1', [org.id])).rows[0];
    // Stable first, for the prompt cache: rules, map and guide; then the organisation (stable within a session)
    const system = [
      { type: 'text', text: `You are Yai, the ConsolX assistant for the team preparing the consolidated accounts of ${org.name}${org.client ? ' (' + org.client + ')' : ''}. You show anyone, step by step, how to use ConsolX — the Admin and User views, from setting up the entities, ownership, chart of accounts and reporting periods to the packs, intragroup validation, group journal entries and reports — and you help prepare the upload kits: what goes in each file and, for the CSV kits, the file itself, ready to import.\n\n` + RULES +
        '\n\n<consolx_app_map>\n' + APP_MAP + '\n</consolx_app_map>\n\n<consolx_guide>\n' + GUIDE + '\n</consolx_guide>', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '<organisation as_of="' + new Date().toISOString().slice(0, 10) + '">\n' + orgSummary(st && st.state, org.name) + '\n</organisation>', cache_control: { type: 'ephemeral' } },
    ];
    const hist = (Array.isArray(b.history) ? b.history : []).slice(-MAX_TURNS * 2)
      .filter(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string' && t.text.trim())
      .map(t => ({ role: t.role, content: t.text.slice(0, 20000) }));
    while(hist.length && hist[0].role !== 'user') hist.shift();
    /* the API wants turns to alternate: merge a run of the same role (e.g. a question whose answer failed) */
    const turns = [];
    hist.forEach(t => { const last = turns[turns.length - 1]; if(last && last.role === t.role) last.content += '\n\n' + t.content; else turns.push(t); });
    if(turns.length && turns[turns.length - 1].role === 'user') turns.pop();
    const messages = turns.concat([{ role: 'user', content: '(I am on: ' + (where || 'the home page') + '; ' + view + ')\n' + qn }]);
    let r;
    try {
      r = await api().beta.messages.create({ model: MODEL, max_tokens: 16000, output_config: { effort: 'medium' },
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', system, messages });
    } catch(e){
      log(e);
      if(e instanceof Anthropic.RateLimitError) return fail(res, 429, 'Yai is busy: try again in a minute.');
      if(e instanceof Anthropic.APIError && e.status) return fail(res, 502, 'Yai could not answer just now (' + e.status + ').');
      return fail(res, 502, 'Yai could not be reached.');
    }
    const text = r.stop_reason === 'refusal' ? 'I can’t help with that one. For questions about ConsolX or the consolidation, try asking another way.'
      : (r.content || []).filter(x => x.type === 'text').map(x => x.text).join('').trim() || 'I have no answer to that; try asking another way.';
    const us = r.usage || {};
    const row = (await q(`INSERT INTO ai_usage(org_id, month, questions, input_tokens, output_tokens, cache_read_tokens) VALUES ($1, $2, 1, $3, $4, $5)
      ON CONFLICT (org_id, month) DO UPDATE SET questions = ai_usage.questions + 1, input_tokens = ai_usage.input_tokens + $3,
        output_tokens = ai_usage.output_tokens + $4, cache_read_tokens = ai_usage.cache_read_tokens + $5 RETURNING questions`,
      [org.id, month(), us.input_tokens || 0, us.output_tokens || 0, us.cache_read_input_tokens || 0])).rows[0];
    res.json({ answer: text, truncated: r.stop_reason === 'max_tokens', usage: { questions: row.questions, allowance: cap } });
  }
  /* tests: answer with a stand-in for the Anthropic client */
  const useClient = c => { client = c; };
  return { enabled, status, ask, useClient };
}
module.exports = { assistant, orgSummary };
