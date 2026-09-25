# ConsolX — Railway deployment package

Tested locally before packaging: `npm install && PORT=9234 npm start` was
run against this exact folder, confirmed serving `index.html` at `/` with
a `200`, and the byte count served matched the source file exactly
(1,212,952 bytes) — nothing was truncated or corrupted in the copy.

## What's in here

- `index.html` — the whole app (self-contained, no other assets)
- `package.json` / `package-lock.json` — pulls in [`serve`](https://www.npmjs.com/package/serve), a tiny static file server
- `railway.json` — tells Railway exactly how to build and start it (Nixpacks + `serve`)
- `.gitignore` — keeps `node_modules` out of git

No Dockerfile needed — Railway's Nixpacks builder auto-detects this as a
Node project from `package.json` and runs `npm install` then `npm start`.
`serve -s . -l $PORT` binds to whatever port Railway assigns via the
`PORT` environment variable (Railway sets this automatically — don't
hardcode a port anywhere).

---

## Step-by-step deploy

### 1. Get the code into a place Railway can pull from

Railway deploys either from a GitHub repo (recommended — gives you
auto-deploy on every push) or directly from your machine via their CLI.
Pick one:

**Option A — GitHub (recommended)**
```bash
cd consolx-railway
git init
git add .
git commit -m "ConsolX static app"
```
Then create a new empty repo on GitHub (no README/license, so there's no
merge conflict) and push:
```bash
git remote add origin https://github.com/<your-username>/<repo-name>.git
git branch -M main
git push -u origin main
```

**Option B — Railway CLI, no GitHub needed**
```bash
npm install -g @railway/cli
railway login
cd consolx-railway
railway init
railway up
```
This uploads the folder directly and deploys it — good if you'd rather
not create a repo for this yet.

### 2. Create the Railway project

Once your Railway account (that you're setting up now) is ready:

1. Railway dashboard → **New Project**.
2. If you went with Option A: choose **Deploy from GitHub repo**, authorize
   Railway to access your GitHub account if prompted, and pick the repo
   you just pushed.
   If you went with Option B: `railway up` already created and deployed
   the project for you — skip to step 3.
3. Railway will detect `package.json`, build with Nixpacks, and start it
   with the command from `railway.json`. First deploy usually takes well
   under a minute for something this small.

### 3. Get it publicly reachable

By default a new Railway service isn't exposed to the internet yet.

1. Open the service → **Settings → Networking**.
2. Click **Generate Domain** — gives you a free
   `something.up.railway.app` URL immediately, HTTPS included. Good
   enough to sanity-check the deploy before touching DNS.

### 4. Point your real domain at it

Once you've picked and bought a domain (from the earlier
`getconsolx.com` / `consolx.io` discussion):

1. Same **Settings → Networking** panel → **Custom Domain** → enter your
   domain (or a subdomain like `app.getconsolx.com`).
2. Railway gives you a CNAME target (something like
   `xxxx.up.railway.app`). Add that as a CNAME record at your registrar's
   DNS settings — Cloudflare/Porkbun both do this from their dashboard's
   DNS tab, root-domain CNAME flattening is supported by both.
3. Wait for DNS to propagate (usually minutes, sometimes up to a few
   hours) — Railway auto-provisions an HTTPS certificate once it sees the
   CNAME resolve correctly.

### 5. Redeploys

- Option A (GitHub): every `git push` to the connected branch auto-deploys.
- Option B (CLI): run `railway up` again from the folder whenever you've
  updated `index.html`.

---

## Notes specific to this app

- **No environment variables needed** — this is a pure static file, no
  API keys, no database. Don't add any unless/until the app actually
  grows a real backend (the heavy-calculation/big-file backend options we
  discussed separately would be a *second* Railway service, not a change
  to this one).
- **No database/volume needed either** — data lives in each visitor's
  browser `localStorage`, not on the server.
- If you later split off a backend service for heavy calculations, that
  would live as its own Railway service in the same project — this
  static frontend stays exactly as-is.
