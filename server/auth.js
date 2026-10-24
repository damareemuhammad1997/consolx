/* Accounts and sessions. A session is a random token in an HttpOnly cookie; only its SHA-256 is stored.
   Mutating API calls must carry the X-ConsolX header, which a cross-site form cannot send (CSRF guard,
   on top of SameSite=Lax cookies). */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { q } = require('./db');

const COOKIE = 'cx_sid';
const TTL_DAYS = 14;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const secureCookies = () => process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;

function hashPassword(pw){ return bcrypt.hash(String(pw), 10); }
function checkPassword(pw, hash){ return bcrypt.compare(String(pw), hash); }
function passwordProblem(pw){
  pw = String(pw || '');
  if(pw.length < 10) return 'Passwords need at least 10 characters.';
  if(!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Passwords need letters and numbers.';
  return null;
}
function randomPassword(){ return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '') + '7a'; }

function parseCookies(req){
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if(i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function setCookie(res, value, maxAgeSec){
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureCookies() ? '; Secure' : ''}`);
}

async function createSession(res, userId, orgId){
  const token = crypto.randomBytes(32).toString('hex');
  await q(`INSERT INTO sessions(token_hash, user_id, org_id, expires_at) VALUES ($1,$2,$3, now() + interval '${TTL_DAYS} days')`, [sha(token), userId, orgId || null]);
  setCookie(res, token, TTL_DAYS * 86400);
}
async function destroySession(req, res){
  const t = parseCookies(req)[COOKIE];
  if(t) await q('DELETE FROM sessions WHERE token_hash = $1', [sha(t)]);
  setCookie(res, '', 0);
}

/* req.user = { id, email, name, title, is_superadmin, client_id, must_change_password, session_org }
   or null; a disabled user, or a user of a suspended client, has no session */
async function loadUser(req, res, next){
  req.user = null;
  try {
    const t = parseCookies(req)[COOKIE];
    if(t){
      const { rows } = await q(`SELECT u.id, u.email, u.name, u.title, u.is_superadmin, u.client_id, u.must_change_password, s.org_id AS session_org, s.token_hash,
          c.status AS client_status
        FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN clients c ON c.id = u.client_id
        WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`, [sha(t)]);
      const u = rows[0];
      if(u && (u.is_superadmin || u.client_status === 'active')) req.user = u;
    }
  } catch(e){ return next(e); }
  next();
}
function requireUser(req, res, next){ if(!req.user) return res.status(401).json({ error: 'Please sign in.' }); next(); }
function requireSuper(req, res, next){ if(!req.user || !req.user.is_superadmin) return res.status(403).json({ error: 'Administrator only.' }); next(); }
function csrf(req, res, next){
  if(['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  if(req.get('X-ConsolX') !== '1') return res.status(403).json({ error: 'Missing request header.' });
  next();
}

/* login throttle: 8 failures per address and per e-mail in 15 minutes */
const fails = new Map();
function throttled(key){
  const now = Date.now(), x = fails.get(key);
  if(!x || now - x.t > 15 * 60e3) return false;
  return x.n >= 8;
}
function fail(key){ const now = Date.now(), x = fails.get(key); if(!x || now - x.t > 15 * 60e3) fails.set(key, { n: 1, t: now }); else x.n++; }

async function login(req, res){
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const pw = String((req.body || {}).password || '');
  const kIp = 'ip:' + req.ip, kEm = 'em:' + email;
  if(throttled(kIp) || throttled(kEm)) return res.status(429).json({ error: 'Too many attempts — wait 15 minutes and try again.' });
  const { rows } = await q(`SELECT u.*, c.status AS client_status FROM users u LEFT JOIN clients c ON c.id = u.client_id WHERE lower(u.email) = $1`, [email]);
  const u = rows[0];
  if(!u || !(await checkPassword(pw, u.password_hash))){ fail(kIp); fail(kEm); return res.status(401).json({ error: 'That e-mail and password do not match.' }); }
  if(u.status !== 'active') return res.status(403).json({ error: 'This account is disabled. Contact your administrator.' });
  if(!u.is_superadmin && u.client_status !== 'active') return res.status(403).json({ error: 'Your organisation’s access is suspended. Contact your administrator.' });
  fails.delete(kEm);
  /* open the first organisation the user belongs to */
  const m = await q('SELECT org_id FROM memberships WHERE user_id = $1 ORDER BY org_id LIMIT 1', [u.id]);
  await q('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
  await createSession(res, u.id, m.rows[0] ? m.rows[0].org_id : null);
  res.json({ ok: true, superadmin: u.is_superadmin, mustChangePassword: u.must_change_password });
}

/* first start: the administrator from ADMIN_EMAIL / ADMIN_PASSWORD, or a generated password printed once */
async function bootstrapAdmin(){
  const { rows } = await q('SELECT count(*)::int AS n FROM users WHERE is_superadmin');
  if(rows[0].n) return;
  const email = (process.env.ADMIN_EMAIL || 'admin@consolx.local').trim().toLowerCase();
  let pw = process.env.ADMIN_PASSWORD, generated = false;
  if(!pw || passwordProblem(pw)){ pw = randomPassword(); generated = true; }
  await q('INSERT INTO users(email, name, title, password_hash, is_superadmin, must_change_password) VALUES ($1,$2,$3,$4,true,$5)',
    [email, 'Administrator', 'Administrator', await hashPassword(pw), generated]);
  console.log(`[consolx] administrator created: ${email}` + (generated ? ` — temporary password: ${pw} (change it at first sign-in)` : ' (password from ADMIN_PASSWORD)'));
}

module.exports = { hashPassword, checkPassword, passwordProblem, randomPassword, loadUser, requireUser, requireSuper, csrf, login, destroySession, createSession, bootstrapAdmin, sha, parseCookies, COOKIE };
