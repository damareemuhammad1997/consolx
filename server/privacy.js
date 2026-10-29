/* Keep the group's identifying names inside the environment.
   Before anything is sent to the AI service, the organisation's own names — the organisation and client names, the
   entities' legal names, and the names of individual or outside shareholders — are replaced by generic labels
   (Company 1, Company 2 …, Person 1 …). The answer that comes back is put through the reverse map, so the real
   names reappear only here, on our server, never leaving it. Codes, currencies, countries, dates and figures are
   not names and are left as they are. The map is built per request and held only for that request. */
'use strict';

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildPseudonymizer(state, org){
  const S = state || {};
  const seen = new Map();   // real name (lower-cased) -> label, so the same name always gets the same label
  const pairs = [];         // [realName, label]
  let coN = 0, peN = 0;
  const add = (real, kind) => {
    const r = String(real == null ? '' : real).trim();
    if(r.length < 2) return;                 // nothing, or a single character, is not a name worth masking
    const key = r.toLowerCase();
    if(seen.has(key)) return;
    const label = kind === 'person' ? 'Person ' + (++peN) : 'Company ' + (++coN);
    seen.set(key, label); pairs.push([r, label]);
  };
  if(org){ add(org.name, 'company'); add(org.client, 'company'); }
  (Array.isArray(S.entities) ? S.entities : []).forEach(e => add(e.legalName, 'company'));
  (Array.isArray(S.nonEntityShareholders) ? S.nonEntityShareholders : []).forEach(x => add(x.name, x.type === 'individual' ? 'person' : 'company'));

  /* out: match the real names, longest first (so "Alpha Holdings" wins over "Alpha"), any case */
  const fwd = pairs.slice().sort((a, b) => b[0].length - a[0].length);
  const maskRe = fwd.length ? new RegExp(fwd.map(p => escapeRe(p[0])).join('|'), 'gi') : null;
  const maskLut = new Map(fwd.map(p => [p[0].toLowerCase(), p[1]]));
  const mask = text => (!maskRe || text == null) ? text : String(text).replace(maskRe, m => maskLut.get(m.toLowerCase()) || m);

  /* back: match the labels we handed out, longest first, tolerant of case and the space (Company 3 / company3) */
  const rev = pairs.slice().sort((a, b) => b[1].length - a[1].length);
  const unmaskRe = rev.length ? new RegExp('\\b(' + rev.map(p => escapeRe(p[1]).replace(/ +/g, ' *')).join('|') + ')\\b', 'gi') : null;
  const unmaskLut = new Map(rev.map(p => [p[1].replace(/\s+/g, '').toLowerCase(), p[0]]));
  const unmask = text => (!unmaskRe || text == null) ? text : String(text).replace(unmaskRe, m => unmaskLut.get(m.replace(/\s+/g, '').toLowerCase()) || m);

  return { mask, unmask, count: pairs.length, pairs };
}

module.exports = { buildPseudonymizer };
