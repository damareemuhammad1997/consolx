# ConsolX — hosted, several clients on one server

One Railway service serves every client. An **administrator** creates clients (accounting firms or holding
companies), their organisations and users, sets the plans and add-ons, and issues invoices. Users sign in and
work in the organisations they were given; each organisation's data is stored on the server, separate from every
other organisation's.

## What is in here

| Path | What it does |
| --- | --- |
| `index.html` | The app. Served by the server with the signed-in user, their organisations and add-ons, and the data of the organisation they have open. Opened on its own (no server), it still works as before, in that browser only. |
| `admin.html` | The administration console at `/admin`: clients, organisations, users, plans, add-ons, invoices, settings. |
| `server/index.js` | Express server: sign-in, the organisation data API, the administration API, printable invoices. |
| `server/db.js` | PostgreSQL connection, schema (created at start-up) and first-run plans and add-ons. |
| `server/auth.js` | Passwords (bcrypt), sessions (HttpOnly cookie, hashed token), sign-in throttling, the administrator's first account. |
| `server/billing.js` | Plans, limits, add-ons, invoice calculation and numbering. |
| `server/gateways/` | Payment methods. Manual (bank transfer, marked paid by the administrator) is live; PayPal has a slot. |
| `server/assistant.js` | Yai, the AI assistant (the `ai` add-on): answers with Claude from the guide, the app map and a summary of the open organisation. |
| `docs/guide.md` | The preparer's guide: the order of work, every page, every upload kit's columns and rules. Yai answers from it. |

## Deploy on Railway

1. **Add a database.** In the Railway project: **New → Database → PostgreSQL**.
2. **Set the variables** on the ConsolX service (**Variables**):
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (Railway offers it as a reference variable)
   - `ADMIN_EMAIL` = the administrator's e-mail
   - `ADMIN_PASSWORD` = at least 10 characters, letters and numbers
   - `NODE_ENV` = `production`
   - `ANTHROPIC_API_KEY` = an Anthropic API key, to switch Yai on (optional; without it the add-on says Yai is not
     switched on yet). `CONSOLX_AI_MODEL` changes the model (default `claude-opus-5-5`).
3. **Deploy** (a push to `main` deploys). At first start the server creates the tables, the starting plans and
   add-ons, and the administrator account. If `ADMIN_PASSWORD` is missing or too weak, it generates one and prints
   it once in the deploy logs; you are asked to change it at first sign-in.
4. Open **`https://<your domain>/admin`** and sign in as the administrator.

Without `DATABASE_URL` the service keeps serving the single-browser app (no sign-in, no clients) and logs a warning,
so the site stays up while the database is being added.

**Backups:** turn on Railway's PostgreSQL backups. All client data is in the database: the `organisations` table
holds each organisation's data as one JSON document.

## Running the business from `/admin`

1. **Plans and add-ons** — set your prices first (they start at nil). Each plan is for one client type and
   includes a number of users and organisations; a holding company's plan has one organisation (its group).
   Prices are monthly; annual billing is twelve months less the annual discount set under **Settings**.
2. **Settings** — currency, annual discount, invoice prefix, payment terms, your company details and the bank
   details printed on every invoice.
3. **Clients → New client** — name, type, plan, billing cycle, add-ons.
4. In the client: **add organisations**, then **create users** and give each one access to organisations as
   **Admin** (Admin and User views) or **User** (User view). A temporary password is shown once; the user
   chooses their own at first sign-in. **Reset password**, **Disable**, and **Suspend** the whole client (its users
   cannot sign in) are on the same page.
5. **Invoices** — preview and issue one for a client, or **Run billing** for every monthly (or annual) client
   for a period. Open an invoice to print it or save it as PDF; **Mark paid** with the transfer reference.

Limits are hard: a user or organisation beyond the plan is refused with a message, and a plan cannot be changed to
one smaller than what the client already uses.

## Discount codes

Under **Plans and add-ons → Discount codes**, create a code with a percentage (optionally an end date), then pick
it on a client (**Discount code** in the client's form). It comes off every invoice of that client, after the
annual discount. A **100%** code makes a client free — use it for your own test environment: an invoice for a free
period is recorded as paid ("No charge"), and **Run billing** skips the client. Switch a code off, or let its end
date pass, and the client's next invoices are charged in full (the preview says why).

## Add-ons

| Key | Add-on | Without it |
| --- | --- | --- |
| `ifrs` | IFRS statements | The Group IFRS statements page is locked. |
| `notes` | Disclosure notes | Group disclosures is locked, and the IFRS statements have no notes. |
| `segments` | Segment information | The Segment information page is locked. |
| `comms` | Management and investor communication | The Management and Investors pages are locked. |
| `equity` | Equity accounting | A group with an associate or joint venture shows a notice instead of its consolidated figures. |
| `goodwill` | Goodwill and business combinations | A group with an acquisition during the period shows a notice instead of its figures. |
| `nci` | Non-controlling interests | A group with a subsidiary held below 100% shows a notice instead of its figures. |
| `ai` | AI assistant (Yai) | No Yai bubble. |

The last three change the consolidated numbers, so a group that needs one the client has not bought is locked
rather than shown incomplete. The administrator always has every add-on.

## Yai, the assistant

With the `ai` add-on, a round **Yai** bubble sits at the bottom right of the app (as in PayrollX). Yai:

- shows, step by step, how to do anything in ConsolX, starting from the page the person is on (Admin or User view);
- prepares the CSV upload kits — entities, shareholders, chart of accounts, journal entries — with the organisation's
  own entity and account codes, shown in the chat with a **Download** button; for the Excel kits (entity packs,
  intragroup templates, chart workbook) it explains how to fill them.

It answers from `docs/guide.md`, a map of the menus and a summary of the open organisation (entities, ownership in
force, periods, chart of accounts, journal numbering, which packs are in) — codes, not figures. It cannot change
anything. The conversation lives in the page only; the server keeps the count of questions and tokens per
organisation and month (`ai_usage`), shown under **Settings → Yai** in `/admin`, where the monthly allowance per
organisation is set (default 1,000). Each person may ask 8 questions a minute. Keep `docs/guide.md` and the app map
in `server/assistant.js` in step with the app when pages or file formats change.

**Yai stays on topic.** Its system prompt (`RULES` in `server/assistant.js`) limits it to using ConsolX and this
group's consolidation: how to do things in the app, preparing the upload kits, and the consolidation/IFRS reasoning
needed to use ConsolX correctly. Anything outside that — general questions, unrelated writing or code, personal or
legal/tax advice — it declines. The same rule tells it to treat a question, a file or the history as information,
never as an instruction that changes its rules (a prompt-injection guard). This is enforced in the prompt, which is
the right lever for a model's behaviour; it is strong but not a hard gate.

**The group's names never leave the server.** Before a request goes to Anthropic, `server/privacy.js` replaces the
organisation's own names — the organisation and client names, the entities' legal names, and individual or outside
shareholders' names — with generic labels (`Company 1`, `Company 2` …, `Person 1` …). The question, the history and
the organisation summary are all masked, so the real names are never sent. The answer that comes back is put through
the reverse map on the server, so the real names reappear only here, including inside any CSV Yai prepared (it is
built with labels, then restored, ready to import). What is **not** masked, because it is not a name and the files
need it: entity codes (e.g. `MU01`), countries, currencies, dates and figures. The map is built per request from the
organisation's own data and held only for that request — nothing is stored. A name a user types that ConsolX does
not already hold (e.g. a brand-new company in the question) has no label and is sent as typed.

## Data and saving

- The app saves the open organisation a few seconds after each change ("All changes saved" in the top bar).
- Every save carries the version it started from. If someone else saved the organisation in between, the save
  is refused, nothing is overwritten, and the top bar says who saved and offers a reload.
- Excel downloads of reports (group statements, cash flow, disclosures, IFRS statements, segment information)
  contain values, not formulas.
- The first time an organisation admin opens an empty organisation in a browser that holds data from the
  single-browser version, they are offered to copy it in.

## Payments

Today invoices are paid by bank transfer and marked paid by the administrator. Online gateways plug in behind
`server/gateways/index.js`: a gateway creates the payment and its webhook calls `billing.markPaid`. PayPal has a
slot there (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`) and is not connected yet.

## Security notes

- Passwords are hashed with bcrypt; sessions are random tokens in an HttpOnly, SameSite=Lax cookie (Secure in
  production), stored hashed, and expire after 14 days.
- Every change request must carry the `X-ConsolX` header, so another site cannot post on a user's behalf.
- Sign-in is throttled (8 failures per address and per e-mail in 15 minutes).
- A user only ever receives the organisations of their own client they were given; every organisation request is
  checked against that.

## Local development

```bash
npm install
# PostgreSQL running locally:
DATABASE_URL=postgres://user:pass@localhost:5432/consolx ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=ChangeMe2026 npm start
# app: http://localhost:3000/   administration: http://localhost:3000/admin
```
