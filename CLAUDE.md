# Claude orientation — metalfab repo

This file is loaded automatically when Claude Code opens this directory. It exists to keep new sessions from rediscovering the same things every time.

## What this repo is

TCB Metalworks bid takeoff pipeline. TCB is a steel fabrication shop in **Racine, WI** that bids as a sub on construction projects. The program reads 200–800-page bid PDFs (drawings + CSI specs) and produces a takeoff (line-item BOM + labor) → proposal → submission. End-to-end goal stated by Colin (the owner): blueprints+docs in → proposal/price out.

Pipeline stages: `plan-intelligence` → `coverage` (deleted on the active branch) → `takeoff` → `audit` → `arbitrate` → `proposal`.

## Where to start any new task

1. **`git branch --show-current`** — confirm you know which branch you're on.
2. **`git fetch --all && git branch -a`** — main is usually behind the active feature branch.
3. **`gh pr list`** — open PRs are where the live work is.
4. Read `nestle/handoff/HANDOFF.md` if it exists — that's the current project status doc.
5. Memory at `~/.claude/projects/C--Users-yeehuzz-metal/memory/` is auto-loaded; trust it as a starting point but verify against current code/state before acting.

## Active branch (as of 2026-05-03)

`claude/nestle-real-rerun` (PR #25, OPEN). This is **significantly ahead of main** (~10 commits, +4152 / -2245 lines). The architecture has pivoted:

- Coverage-manifest system has been **deleted** (build-manifest.js, tcb-scope-policy.js, RunCoverageButton, coverage/run route, coverage-manifest.test.js, scripts/coverage.js, migration 017_coverage_manifests.sql — all gone).
- Replaced with measurement-driven plan-intelligence (auto-render at scale=4, geometry extraction, dimension-chain detection) + autonomous takeoff loop (`scripts/takeoff-run.js`) + ~24 line-level + 5 run-level validators in `lib/takeoff/validate.js`.
- `supabase/migrations/017_takeoff_run_status.sql` collides with main's `017_coverage_manifests.sql` — same number, different content. Will need renumbering before merge.

Do not blindly apply patterns from main; verify the relevant file is on the current branch first.

## Critical infrastructure bug — read before running anything in production

**Plan-intelligence has been failing on every Vercel run** since the architecture pivot. pdfjs worker resolution error in `/var/task` runtime. The persisted `plan_intelligence` row in Supabase has empty fields (`drawings: 0`, no `category_pages`, no `drawing_index`, no schedules). The takeoff agent has been working blind — only raw PDFs, no structured digest. This is the root cause of "small things keep getting missed."

**Workaround:** run `node scripts/plan-intelligence.js --opp=<id> --dry-run` locally where pdfjs works. Get a real digest from `plan-intelligence/<opp>/digest.json`.

**Real fix (deferred):** `next.config.mjs` `serverExternalPackages` / worker file deployment. ~half a day. Pending Colin's go-ahead.

See `~/.claude/projects/C--Users-yeehuzz-metal/memory/project_plan_intel_vercel_bug.md` for full diagnosis.

## Active bid

Nestle Schaumburg / Camosy. Opp ID `98d107a3-2558-4a24-8d2c-5b3817771d6b`. Title `Camosy / Nestle Schaumburg`. Due **2026-05-08, 5pm EST**. Bid total: **$40,249**. Submission via Camosy Ariba portal — Colin submits, not us.

Files:
- Source: `nestle/nestle camosy/` (6 files: GC bid form xlsx, SOW pdf, scope-areas pdf, 79-page permit set pdf, OCIP docx, labor rate doc)
- Snapshot: `nestle/snapshot/` (gitignored — opportunity row, takeoff lines, plan_intelligence local rerun, rendered PNGs, independent inventory)
- Handoff: `nestle/handoff/HANDOFF.md` + `TCB_Nestle_GC_Bid_Form_DRAFT.xlsx`
- Plan: `~/.claude/plans/glimmering-toasting-hopcroft.md`

## Conventions baked into this repo

- **No Anthropic API.** Takeoff/audit/arbitrate run through `claude -p "$(cat scripts/<stage>.md)"` on Colin's subscription. Never add `@anthropic-ai/sdk` or `ANTHROPIC_API_KEY`.
- **UI-first.** When Colin can't run a CLI script, ship the button alongside the backend feature. Backend stages with no Run button right now: takeoff, audit, arbitrate (CLI-only by design until Colin asks for buttons).
- **Tests as documentation.** `tests/adversarial-fixture.test.js` is plain Node, run via `node tests/<file>.test.js`. Each case is a planted-bomb regression for a real past failure mode. Don't delete tests — add new `check()` calls.
- **Manual migrations.** SQL files in `supabase/migrations/NNN_*.sql` are NEVER auto-applied by CI. Paste into the Supabase SQL editor.
- **Validators fail loud at commit.** `scripts/takeoff-commit.js` runs `lib/takeoff/validate.js` and refuses commit on `error`-severity findings. Each validator is institutional memory for a past failure class.
- **No CI.** No `.github/workflows`. Vercel handles PR builds via its GitHub integration only.

## Operators

- **Colin Merrill** (`colin.merrill1@gmail.com` on git, `colin@tcbmetalworks.com` for digests) — owner. Non-technical. Drives via UI. Will not run CLI scripts.
- **Gohar** (`gohar@tcbmetalworks.com`) — estimator, gets daily digest emails.
- **Thomas** — labor-prior expert (cited by validator messages, not actively in this repo).
- **VA** — runs daily routines via quoteautomator.com (the production CRM URL — different from `tcbmetalworks.vercel.app` in `.env.local.example`).

## Conventions for me (Claude) on this repo

These are reinforced in memory but live here too because they shape every action:

1. **Don't auto-commit.** Wait for explicit "yes commit it" even with auto mode on. The user vets every commit before push.
2. **Don't act for Colin externally.** No sending RFIs from his email. No submitting bids. No emailing GCs.
3. **Verify before claiming "done."** Run the actual command. Open the actual file. Don't assert from memory after compaction.
4. **Output a `HANDOFF.md` (or equivalent) for multi-step work.** The user forwards docs to Colin; chat summaries get lost.
5. **Every "task done" message ends with an honest confidence audit** — HIGH / MEDIUM / LOW with what could still fail.
6. **Match deadline urgency over architectural elegance.** Real bids beat refactor projects.

## Git identity (already set globally; restating for safety)

Commit as:
```
git -c user.name="huzvert" -c user.email="huzvert@users.noreply.github.com" commit -m "..."
```

Never commit as `onkauldata@gmail.com`.

## Useful commands

```bash
# Where am I?
git branch --show-current && git status

# Who else is working?
git fetch --all && git branch -a && gh pr list

# Run plan-intelligence locally (works; Vercel doesn't right now)
node scripts/plan-intelligence.js --opp=<id> --dry-run

# Inspect a specific page or pattern in the permit set
node scripts/inspect-pdf.mjs --pdf=<path> --action=search --pattern=<regex>
node scripts/inspect-pdf.mjs --pdf=<path> --action=measure --page=<n> --x=<n> --y=<n>

# Validate a takeoff (no DB write)
node scripts/takeoff-commit.js --opp=<id> --dry-run --findings-out=/tmp/f.json

# Run tests (plain Node, no test runner)
node tests/adversarial-fixture.test.js
node tests/nestle-bid-form.test.js

# Build (catches type errors + ESLint)
npm run build
```
