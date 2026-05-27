# Job Application Tracker

An AI-powered Google Apps Script that watches your Gmail inbox, identifies
job-application emails, classifies their status, and maintains a live Google
Sheet as both database and dashboard — with zero infrastructure to deploy.

Built with Claude Haiku as the classifier brain.

![Apps Script](https://img.shields.io/badge/Apps%20Script-4285F4?logo=google&logoColor=white)
![Gmail API](https://img.shields.io/badge/Gmail-EA4335?logo=gmail&logoColor=white)
![Google Sheets](https://img.shields.io/badge/Sheets-0F9D58?logo=googlesheets&logoColor=white)
![Anthropic Claude](https://img.shields.io/badge/Claude-D97757?logo=anthropic&logoColor=white)

---

## What it does

Every five minutes, the script:

1. **Searches Gmail** for messages from known ATS systems (Greenhouse, Lever,
   Workday, Ashby, LinkedIn, Indeed, etc.) and messages matching
   job-application subject patterns in English and Spanish.
2. **Sends each candidate thread to Claude** in a single API call. The model
   returns structured JSON: `is_application`, `company`, `role`, `status`,
   `source`, `salary_range`, `location`, `career_site`, `notes`, and a
   `confidence` score.
3. **Upserts into a Google Sheet** keyed by `(company, role)`. Status only
   advances forward — `Offer` never gets overwritten by `Applied`. Terminal
   states (`Rejected`, `Accepted`, `Withdrawn`) always win.
4. **Labels the email** so it's never reprocessed.

Every classification — including ones skipped — is logged to an `Event Log`
tab so you can audit exactly what the model saw and why.

## Demo: the sheet

| Company | Role | Status | Applied Date | Last Update | Source | Salary | Location | Notes | Confidence |
|---|---|---|---|---|---|---|---|---|---|
| CAPTRUST | Senior Business Analyst | Applied | 2026-05-26 | 2026-05-26 | LinkedIn | | Raleigh, NC | Application submitted… | 0.95 |
| Stripe | Software Engineer | Interview Scheduled | 2026-05-12 | 2026-05-24 | Direct | | Remote | Final round with eng team | 0.92 |
| Acme Co. | Product Manager | Rejected | 2026-05-08 | 2026-05-20 | Referral | | NYC | Unfortunately, other candidates… | 0.97 |

## Quick start

1. Get an API key from [console.anthropic.com](https://console.anthropic.com).
2. Open [script.google.com](https://script.google.com) → **New project**.
3. Paste `Code.gs` and `Classifier.gs` (as separate files) into the editor.
4. **Project Settings → Script Properties → Add**: `ANTHROPIC_API_KEY` = your key.
5. Run `setup()` once. Grant Gmail, Sheets, Drive, and external-request permissions.
6. Run `backfill()` to import the last 6 months. Re-run until it says complete.
7. Run `installTrigger()` to start the 5-minute polling loop.

Full setup instructions in [`docs/SETUP.md`](docs/SETUP.md).

---

## How I built this — the iteration story

I find it more useful to document *how* a project evolved than to pretend the
final architecture was the original plan. Here's the actual sequence.

### Iteration 1 — start with a PRD, not code

The original idea was a full web app: OAuth into Gmail and Outlook, ingest
emails into Postgres, expose a Next.js dashboard, deploy on Vercel. Before
writing a line of code I drafted a one-page PRD covering problem, non-goals,
target user, data model, privacy concerns, and milestones.

This was the most useful step of the project. The PRD made it obvious that
the OAuth-and-verification flow (especially Google's CASA review for
sensitive Gmail scopes, which can take 6–8 weeks) would be the longest pole
in the tent — completely out of proportion to the actual problem being
solved, which is "where am I in my job pipeline."

### Iteration 2 — kill the database, keep the brain

The pivot: drop the backend entirely. The user already has a perfectly good
database and dashboard available for free — a Google Sheet. Apps Script can
read Gmail, talk to an LLM, and write to Sheets, all running on Google's
infrastructure with no servers, no OAuth app registration, and no
verification queue. Setup time went from "two weeks" to "ten minutes."

The trade-off: Apps Script can only natively read Gmail. Outlook would need
a separate ingestion path (Power Automate, for example) writing into the
same Sheet. For a friends-only deployment where everyone happened to use
Gmail, this was fine.

### Iteration 3 — hybrid classifier

V1 of the classifier was deliberately conservative: deterministic rules
first (sender-domain allowlist + subject regex), with an LLM fallback only
when the rules hit a low-confidence case. This was the textbook "cheap path
first" pattern — rules handle ~70% of cases for free, the LLM handles the
ambiguous 30%.

It worked, but it bothered me a little. Every new ATS or rephrased rejection
required code changes. The classifier code was longer than the rest of the
project combined.

### Iteration 4 — go fully AI

I asked: what if we drop the rules entirely? The honest answer was that
every email would now cost an API call (~$0.001 with Haiku) and latency
would go from ~1 ms to ~2 seconds per email. For a personal tool, neither
matters.

What *does* matter: the Gmail search query itself isn't a classifier — it's
just telling Gmail's server what to fetch. Without it, we'd be sending
Claude every email in the inbox, which is genuinely expensive. So the
final architecture is:

- **Gmail search query** as a cheap pre-filter (server-side, free)
- **Claude Haiku** as the only classifier and extractor (one call returns
  classification + all eight fields)

The `Parser.gs` file (regex-based salary/location/source extraction) was
deleted. Tuning is now done in plain English by editing the prompt.

### Iteration 5 — multilingual

I'm a Spanish speaker, so the first email I tested with — a LinkedIn
confirmation in Spanish — got missed by the Gmail pre-filter. Two changes
fixed it: (1) added the actual LinkedIn phrase `"se ha enviado tu solicitud"`
to the keyword list, and (2) added `from:linkedin.com` as a sender domain
so we catch every LinkedIn job email regardless of language or future
phrasing changes.

The prompt was also updated to tell the model that emails may arrive in any
language, but the `status` enum should always come back in English (so the
sheet's dropdown stays consistent), while `company`, `role`, `location`,
and `notes` should stay in the original language (translating them would
be lossy).

### Iteration 6 — diagnostics over guessing

When the script appeared to do nothing, my first instinct was to start
patching keywords. Instead I added a `diagnose()` function that prints
exactly what's happening at every layer: API key status, sheet existence,
how many threads match the search, what the first 5 subjects are, whether
threads are already labeled as processed, and a live LLM test on a hardcoded
sample email.

This turned a "the script is broken" debugging session into "I haven't run
backfill yet, that's why the sheet is empty." Building observability into
small projects pays for itself the first time you run it.

---

## Architecture

```
┌─────────┐     ┌──────────────┐     ┌────────────┐     ┌─────────────┐
│  Gmail  │ ──> │ Apps Script  │ ──> │   Claude   │ ──> │ Google Sheet│
│         │     │   trigger    │     │   Haiku    │     │ (dashboard) │
│         │     │  every 5min  │     │            │     │             │
└─────────┘     └──────────────┘     └────────────┘     └─────────────┘
                       │                                       │
                       │  appends every decision               │
                       └──────────────────────────────────────>│
                                                          Event Log tab
```

**Files:**

- `Code.gs` — Gmail polling, sheet I/O, status state machine, diagnostics
- `Classifier.gs` — single LLM call returning the full structured result

**State management:** processed threads get a `JobTracker/Processed` Gmail
label so they're never reclassified. The state machine in `pickLatestStatus()`
ensures status only advances; terminal states are sticky.

## Tech stack

| Layer | Tool | Why |
|---|---|---|
| Runtime | Google Apps Script | Zero deployment, native Gmail + Sheets bindings |
| Email | Gmail API (via Apps Script) | Already authenticated as the user |
| Classifier | Claude Haiku 4.5 | Fast, cheap, structured-output capable |
| Database | Google Sheet | Free, shareable, editable, queryable |
| Trigger | Apps Script time-based trigger | 5-minute polling, no Pub/Sub setup |
| Auth | None (script runs as the user) | Sidesteps OAuth verification entirely |

## Cost

Claude Haiku 4.5 costs about $0.001 per email classified. For a heavy
job-search month (~500 candidate emails), expect well under a dollar total.
Processed emails are labeled and never re-classified.
