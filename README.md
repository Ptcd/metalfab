# TCB Metalworks Bid Pipeline CRM

Next.js + Supabase CRM that scrapes public bid opportunities (federal, state,
municipal, GC plan rooms), scores them against TCB Metalworks' capabilities,
deep-analyzes the bid documents with Claude Code, and emails Gohar the
opportunities worth an estimator's time.

## Architecture

```
  [ Vercel + Supabase ]                     [ Local machine + Claude Code ]
  ├ Puppeteer scrapers (nightly cron)       ├ scripts/qa-prepare.js
  ├ Supabase Storage: bid-docs bucket       │   (pulls awaiting_qa queue locally)
  ├ Postgres: opportunities / events        │
  ├ Next.js CRM UI                          ├ Claude Code runs scripts/qa-analyze.md
  └ Brevo email (daily digest)              │   (reads PDFs, writes qa-report.json)
                                            └ scripts/qa-commit.js
                                                (pushes results back, purges rejects)
```

The analysis layer **does not** call the Anthropic API. Claude Code runs
locally on Colin's machine, authenticated via his Claude subscription OAuth.
Vercel/Supabase handle everything else.

## Daily flow

1. **Morning cron (11:00 UTC / 06:00 CT)** → `GET /api/cron/fetch`
   - `runFetchPipeline` — scrapes SAM.gov (and other HTTP-only sources)
   - `scripts/fetch-docs.js` — downloads bid attachments for opportunities
     with score ≥ `qa_min_score_threshold`, promotes them to `awaiting_qa`
2. **Local scrapers** (operator runs on their machine, not on Vercel):
   - `node scripts/run-pipeline.js` — full Puppeteer scrape across all
     sources (BidNet, Bonfire, Milwaukee portals, GC plan rooms, etc.)
3. **Claude Code pass** (operator runs, daily or twice daily):
   ```
   node scripts/qa-prepare.js        # pull awaiting_qa + docs locally
   # open Claude Code, run scripts/qa-analyze.md
   node scripts/qa-commit.js         # push qa-report.json → Supabase
   ```
4. **Afternoon cron (19:00 UTC / 14:00 CT)** → `GET /api/cron/digest`
   - `scripts/send-daily-digest.js` — emails Gohar the opps in
     `qa_qualified` updated in the last 24h, CCs Colin
   - `scripts/cleanup-storage.js` — time-based doc purge
     (won > 90d, lost > 14d, bidding past-deadline > 30d)

Immediate doc purges (no grace period) happen whenever an opportunity moves
to `qa_rejected` (by `qa-commit.js`) or `passed` (by a human in the UI).

## Status state machine

```
           ┌─ auto-triage ──► passed
new ──────►│
           └─ auto-triage ──► reviewing ──► fetch-docs ──► awaiting_qa
                                                               │
                                   Claude Code analyzes docs:  │
                               ┌───────────────────────────────┤
                               │                               │
                               ▼                               ▼
                         qa_qualified                    qa_rejected
                               │                         (docs purged)
                               ▼
                            bidding ──► won / lost
                               │
                        (human action in UI)
```

## Setup

1. `cp .env.local.example .env.local` and fill in Supabase, Brevo, and cron
   secrets. See env comments for which vars are required.
2. Run the migrations in the Supabase SQL editor in order. The QA layer is
   migration `004_qa_layer.sql` — it creates the `bid-docs` storage bucket,
   adds new status values, `documents` / `qa_report` columns, the
   `system_runs` table, and the new scoring_config fields.
3. Install deps: `npm install`
4. Local dev: `npm run dev`

## Cron endpoints

All require `Authorization: Bearer $CRON_SECRET`.

| Path                        | Purpose                                       |
|-----------------------------|-----------------------------------------------|
| `/api/cron/fetch`           | Morning: scrape + fetch-docs (scheduled)      |
| `/api/cron/digest`          | Afternoon: digest + cleanup (scheduled)       |
| `/api/cron/scrape-only`     | Manual: run just HTTP scrapers                |
| `/api/cron/digest-only`     | Manual: send digest, skip cleanup             |
| `/api/cron/cleanup-only`    | Manual: run cleanup (`?dry=1`, `?force=1`)    |

## Local scripts

| Script                               | Purpose                                        |
|--------------------------------------|------------------------------------------------|
| `node scripts/run-pipeline.js`       | Scrape all sources (Puppeteer + HTTP)          |
| `node scripts/fetch-docs.js`         | Download docs for opps passing threshold       |
| `node scripts/qa-prepare.js`         | Pull `awaiting_qa` queue locally for analysis  |
| `scripts/qa-analyze.md`              | Prompt Claude Code uses to analyze PDFs        |
| `node scripts/qa-commit.js`          | Push `qa-report.json` back, purge rejects      |
| `node scripts/send-daily-digest.js`  | Brevo email to Gohar + CC Colin                |
| `node scripts/cleanup-storage.js`    | Time-based purge (supports `--dry-run`/`--force`) |

## Document download coverage

Supported (docs actively pulled):
- SAM.gov / samgov-sgs / usaspending — parses `resourceLinks`, falls back to
  the public `/api/prod/opps/...resources` endpoint
- City of Milwaukee (`milwaukee`) — scrapes detail page for PDF links
- Milwaukee County (`mke-county`) — same pattern
- JP Cullen (`cullen`) — uses Pantera Tools authenticated API when
  `CULLEN_USER` / `CULLEN_PASS` are configured

Flagged `auth_required` (need credentials wired up):
- BidNet Direct, CD Smith, BuildingConnected, Stevens, Scherrer, Bonfire,
  DemandStar, QuestCDN, Sigma, BidBuy

Add a new adapter in [`lib/doc-fetchers/`](lib/doc-fetchers/) and register
it in [`lib/doc-fetchers/index.js`](lib/doc-fetchers/index.js).

## Observability

- `system_runs` table — every cron and Claude Code run is logged with
  duration, step counts, and errors.
- `/activity` — UI view of recent runs and pipeline events.
- `/today` — shows `qa_qualified` opps prominently and reminds the
  operator when `awaiting_qa` has built up.

## Cost model

No Anthropic API billing — analysis runs on the owner's Claude
subscription via Claude Code OAuth. The only running costs are:
- Supabase (DB + Storage)
- Vercel (hosting + cron)
- Brevo (email sends)

## What's NOT automated yet

- Puppeteer-based scrapers don't run on Vercel (needs headful Chromium);
  they run locally.
- Doc download for most portals (see auth_required list) needs credentials
  + cookie preservation added to the per-source adapters.
- Claude Code analysis is triggered manually today; set it up as a Claude
  Code scheduled task if you want it fully hands-off.
