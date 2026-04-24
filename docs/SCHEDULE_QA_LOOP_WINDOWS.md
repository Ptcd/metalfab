# Schedule the QA loop on Windows (one-time setup, ~5 min)

Goal: TCB's daily QA analysis runs automatically on Colin's laptop every
weekday at 12:30 PM — no clicks required.

## Prerequisites (one-time)

1. **Claude Code installed + logged in.** Open a terminal and run:
   ```
   claude login
   ```
   This opens a browser for OAuth. After this, `claude` commands work
   without further prompts.

2. **The repo checked out locally** at the path you usually work from,
   e.g. `C:\Users\onkau\claude\metal fab\`. Make sure `.env.local` is
   filled in with Supabase + Brevo + AOL credentials.

3. **Node.js on PATH.** Open a new terminal and run `node --version` —
   should return a version number. If not, install from nodejs.org.

## Test the script manually first

Open PowerShell **in the repo folder** and run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\qa-loop.ps1
```

You should see:
```
▶ qa-prepare
  (N opportunities staged)
▶ claude -p  (analyzing N opportunities)
  (Claude thinks and writes reports)
▶ qa-commit
  (reports pushed back, statuses flipped)
=== TCB QA loop finished ===
```

Logs land in `logs\qa-loop-YYYYMMDD-HHMMSS.log` — check those if
anything errored.

If this works, you're ready to schedule it.

## Schedule it via Task Scheduler

1. Press `Win+R`, type `taskschd.msc`, hit Enter.
2. Right pane → **Create Basic Task…**
3. **Name:** `TCB QA Loop`
4. **Description:** `Daily Claude Code analysis of TCB's awaiting_qa bid queue`
5. **Trigger:** Daily, **Start time: 12:30 PM**, Recur every 1 day.
   *(If you prefer weekdays-only: pick "Weekly", check Mon–Fri.)*
6. **Action:** Start a program.
7. **Program/script:** `powershell.exe`
8. **Add arguments (optional):**
   ```
   -ExecutionPolicy Bypass -NoProfile -File "C:\Users\onkau\claude\metal fab\scripts\qa-loop.ps1"
   ```
   *(Adjust the path to wherever the repo actually lives.)*
9. **Start in (optional):**
   ```
   C:\Users\onkau\claude\metal fab
   ```
10. Check **"Open the Properties dialog"** before clicking Finish.
11. In Properties → **General** tab:
    - Check **"Run whether user is logged on or not"**
    - Check **"Run with highest privileges"**
12. **Conditions** tab: uncheck **"Start the task only if the computer
    is on AC power"** if the laptop is often on battery.
13. **Settings** tab: check **"If the task is already running, do not
    start a new instance"**, and **"Stop the task if it runs longer
    than: 1 hour"**.
14. Click OK. Windows will ask for your login password — enter it so
    the task can run in the background.

## Verify it's set up right

In Task Scheduler, find **TCB QA Loop**, right-click → **Run**. It should
fire off immediately. Then check `logs\` for the fresh log file.

## What it actually does

- Reads every `awaiting_qa` opportunity from Supabase
- Downloads their PDFs to a temp folder
- Has Claude Code (running under your subscription via the logged-in CLI)
  read the specs and drawings, identify members, and decide bid/pass
- Pushes the results back to Supabase, builds the filtered estimator
  package PDFs, purges docs on rejected opps
- If the queue is empty, exits within 30 seconds without doing anything
  costly

Zero clicks. Roughly 3–10 minutes of runtime depending on how many
opps are queued. Logs saved under `logs\`.

## Troubleshooting

- **Task runs but nothing happens** → check the log. If it says
  "claude CLI not found on PATH," `claude login` was probably run in a
  different user's shell. Re-run `claude login` from the same user the
  task is set to run as.
- **Log shows `claude analysis failed (exit 1)`** → Claude hit a tool
  error mid-way. The `qa-queue/` folder will still have any reports it
  managed to write; run `node scripts/qa-commit.js` manually to commit
  what's there.
- **Reports are low-quality** → tune the prompt in
  `scripts/qa-analyze.md`, commit, push. Next scheduled run uses the
  updated prompt.

## Swap to cloud when the Anthropic scheduler comes back

The equivalent cloud setup is `/schedule` → "TCB daily QA" which will
run the same three commands inside an Anthropic-managed Claude Code
sandbox. When their service is back up, we'll switch from this local
Task Scheduler setup to the cloud one (keep this one running in
parallel until the cloud version is proven).
