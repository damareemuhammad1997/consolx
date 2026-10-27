# ConsolX — the preparer's guide

This is the guide Yai, the ConsolX assistant, answers from. It is also a plain user guide: the order below is the
order a group is set up and consolidated in.

## 1. Who does what

- **Organisation admin** (Admin view and User view): sets up the entities, the ownership register, the chart of
  accounts and the reporting periods.
- **User** (User view only): collects the financial packs, validates intragroup balances and cash flows, posts group
  journal entries and produces the reports.
- Switch between the views from the user menu (your initials, top right). The same menu switches organisation (when
  you have more than one), changes your password and signs you out.
- The app saves on its own a few seconds after each change ("All changes saved" in the top bar). If somebody else
  saved the organisation in between, your save is refused and the bar offers a reload: nothing is overwritten.

## 2. The order of work

1. Admin › Entities › Entity profile — every company of the group (import the entities CSV, or New).
2. Admin › Entities › Ownership register — who holds each company, from which date (import the shareholders CSV).
3. Admin › Entities › Structure chart — check the group tree the register produces.
4. Admin › Chart of accounts — the group chart: statement lines (captions) and accounts for the balance sheet, the
   P&L, OCI and cash flows (import the chart workbook or CSV).
5. Admin › Reporting period — create the period (e.g. FY2026, 01/01/2026 to 31/12/2026), then the wizard:
   step 1 Groups (the consolidation groups and their parents), step 2 Structure movements (acquisitions, disposals and
   changes in holding during the period, validated per group), step 3 Consolidation summary (read only: method and
   percentages per entity), step 4 Foreign currency (opening, average and closing rates for every currency to
   translate; they are then shown, read only, in Currency exchange rates).
6. User › Packs › Financial packs — download each entity's pack, have the entity fill it, upload it back.
7. User › Intragroup › Financials, then Intragroup › Cash flows — split every intragroup balance and cash flow across
   its counterparties; both sides must agree.
8. User › Consolidation › Group journal entries — the consolidation adjustments (import the journals CSV, or New
   journal entry).
9. User › Consolidation — Group balance sheet, Group P&L, Group cash flow, Group disclosures, Group IFRS statements,
   Segment information; User › Reports — Financial reports (each entity's own statements) and IFRS Financial
   Statements; User › Communication — Management and Investors.

Some pages depend on the client's add-ons (IFRS statements, Disclosure notes, Segment information, Communication,
Equity accounting, Goodwill, Non-controlling interests). A page that is not included shows a lock and names the add-on;
the ConsolX administrator adds it.

## 3. Dates, numbers and codes

- Dates are DD/MM/YYYY everywhere (31/12/2026).
- Amounts are plain numbers: no thousands separators, a dot for decimals, no currency symbol. In cash flows, inflows
  are positive and outflows negative.
- Entity codes are made by ConsolX from the country (e.g. FR01, MU02) when an entity is created; files refer to
  entities by that code.
- Account codes look like BS-NCA-001, PL-EXP-004, CF-INV-002: statement, category, number. Categories:
  balance sheet NCA (non-current assets), CA (current assets), EQ (equity), NCL (non-current liabilities),
  CL (current liabilities); P&L INC (income), EXP (expenses), TAX; OCI; cash flow OPE (operating), INV (investing),
  FIN (financing).
- CSV files: comma separated, first row is the header, UTF-8. Excel's "CSV UTF-8" save works.

## 4. The upload kits

### 4.1 Entities CSV (Admin › Entities › Entity profile › Import)

Header (Download template on the import window gives it with two examples):

`legal_name,country,currency,address,tax_id,company_id,gaap,language,reporting_period,incorporation,activity,contact1_name,contact1_title,contact1_email,contact1_phone,contact2_name,contact2_title,contact2_email,contact2_phone`

- Required: legal_name, country (full name, e.g. France, or the two-letter code), currency (three letters, e.g. EUR).
- reporting_period is the year-end month (December). incorporation is a date (DD/MM/YYYY).
- There is no code column: codes are assigned on import. The preview lists every row as Import or Reject, with the
  reason.

### 4.2 Shareholders CSV (Admin › Entities › Ownership register › Import)

Header: `entity_code,entity_name,effective_date,type,shareholder,pct,voting_pct,relationship,reason`

- One row per shareholder of an entity at a date. entity_name is for reading only; entity_code is what counts.
- type: entity (a group company: shareholder is its entity code), individual (a person's name) or nonrelated
  (an outside company's name).
- pct: the holding in %. The holdings of one entity at one date must total exactly 100.
- voting_pct: optional; blank means the same as pct. Voting rights may not total more than 100.
- relationship: optional — control, joint control, joint operation, significant influence, none. Blank takes the
  default from the votes (more than 50% control, exactly 50% joint control, 20% up to 50% significant influence, below 20% none). A relationship other than the
  default needs a reason. Only one shareholder can have control; joint control and joint operation need at least two
  parties.
- An entity's whole history can be in one file: each new effective_date is a change, dated after the previous one.
  A blank effective_date joins the entity's previous dated block.
- The template from the import window pre-lists the entities that have no shareholders yet.

### 4.3 Chart of accounts (Admin › Chart of accounts › Import workbook)

Preferred: the Excel workbook. Download it from the same window (it holds the current chart), edit it and upload it
back. One tab per statement (Balance sheet, Profit or loss, Other comprehensive income, Cash flows). On each tab:
section bands in capitals (NON CURRENT ASSETS, CURRENT ASSETS, EQUITY, NON CURRENT LIABILITIES, CURRENT LIABILITIES;
INCOME, EXPENSES, TAX; OPERATING ACTIVITIES, INVESTING ACTIVITIES, FINANCING ACTIVITIES), then statement lines with
their code, and the accounts with theirs beneath. Columns: Statement line | Code | Account | Code | Intercompany
(Yes/No) | If yes, Intercompany with; the P&L tab adds Add back in cash flow (Yes/No) | Related BS Account (if Yes) |
Cash flow caption (if Yes); the OCI tab adds Goes to reserves | Moves a BS account (Yes/No) | Related BS Account; the
cash flow tab adds Related BS Account. New rows: leave the code empty, numbering is automatic. Re-uploads recognise
codes, so a rename updates rather than duplicates.

Also accepted: a CSV, one row per account:

`statement,category,code,name,fs_caption,intercompany,counterparty,equity_reserve,cf_adjustment,bs_account,cf_caption,bs_caption`

- statement BS, PL, OCI or CF; category must exist and match the statement; code is the number (001) or the full code.
- fs_caption: the statement line the account prints on; created if missing.
- intercompany Yes/No; counterparty: entity codes separated by semicolons, read only when intercompany is Yes.
- OCI rows must name an existing equity reserve (equity_reserve, an EQ account code).
- P&L rows with cf_adjustment Yes (non-cash items such as depreciation) must name bs_account (the BS account they
  move); cf_caption is the operating caption the add-back lands on (e.g. Adjustments for).
- CF rows must name bs_caption: an existing balance sheet caption — every cash movement explains a balance sheet
  movement.
- A row may refer to a caption or an account another row of the same file creates, so one file can build the whole
  chart.

### 4.4 Entity financial pack (User › Packs › Financial packs)

An Excel workbook per entity and period, downloaded from the entity's row and uploaded back whole. Do not rename or
delete sheets.

- Start: instructions and the period.
- TB — <period>: every account pre-listed; type debit and credit balances (in the entity's own currency). The totals
  must balance (difference nil).
- TB — Opening: only when ConsolX has no opening balances for the entity yet: balances at the day before the period
  starts. A company incorporated during the period types YES in the "Newly incorporated" row instead.
- Cash flows: profit before tax and the add-backs are formulas over the TB. Fill the white lines (operating,
  investing, financing), the non-cash section (must net to nil) and the closing check (the cash accounts at closing
  must equal cash at end of period).
- Uploads are all-or-nothing: an unknown account, an unbalanced TB, a non-nil non-cash total or a cash flow that does
  not tie is reported with its sheet and row, and nothing is imported.
- A part-year pack (e.g. an acquisition during the period) covers a window; its sheet names say so.

### 4.5 Intragroup templates (User › Intragroup › Financials, and › Cash flows)

Export all templates (one workbook, one sheet per entity) or one entity's. Each sheet has:

- SUMMARY: each intragroup balance of the entity under an IC Code (e.g. IC-001-US-OIL, or ICF-… for cash flows),
  with its amount in the entity's currency.
- SPLIT: IC Code | Entity ccy | Amount (entity LCY) | Counterparty | CP ccy | Amount (CP LCY) | Counterparty account.
  Split every IC Code across its counterparties in any order; the split amounts of a code must add up to its SUMMARY
  amount (the Check column shows OK).
- Both sides must agree: the counterparty's own split is matched against yours, after translation.

### 4.6 Group journal entries CSV (User › Consolidation › Group journal entries › Import)

Header: `je_number,category,frequency,entity,description,account_code,account_name,debit,credit,posted`

- One row per line; the rows of one entry share its je_number (any label: 1, 2, JE12).
- category: Inter-company elimination, Investment elimination, Fair value adjustment, Unrealised profit, Dividend
  elimination, Reclassification, Other adjustment (another name creates a new category); frequency: One-off or
  Recurring (blank is One-off).
- entity: the entity code the line belongs to (used for segment information); leave it blank for a group-level line.
- account_code: any account of the chart, including cash flow accounts (CF-…). account_name is for reading only.
- debit and credit: positive numbers; one of them per line.
- posted: Yes or No. A posted entry must balance: debits equal credits on the balance sheet and P&L lines, and its
  cash flow lines must net to nil or to its effect on operating cash flows.
- Lines starting with # are ignored (use them for notes).
- All-or-nothing: an unknown account or an unbalanced posted entry rejects the whole file, naming the entry.
- Amounts are in the group's presentation currency.

### 4.7 What Yai can prepare

Yai can draft the CSV kits above (entities, shareholders, chart of accounts CSV, journal entries) from what you tell
it — with the organisation's own entity codes and account codes — as a file to download, check and import. The Excel
kits (entity packs, intragroup templates, the chart workbook) come from the pages themselves: Yai explains how to fill
them.

## 5. Common messages

- "Select a reporting period first": choose the period in the top bar, or create one in Admin › Reporting period.
- "account … is not in the chart of accounts": add the account (Admin › Chart of accounts) or fix the code.
- "Holdings total …% — must equal 100%": the shareholders of an entity at a date must add up to 100.
- "A change must be dated after the previous split": a new ownership date must be later than the last one on file.
- "marked posted but debits do not equal credits": balance the entry, or import it with posted No and fix it on the
  page.
- A locked page: the client's plan does not include that add-on; the ConsolX administrator adds it.
- "saved changes to this organisation after you opened it": reload; your unsaved change was not written.
