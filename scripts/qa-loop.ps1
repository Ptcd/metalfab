# qa-loop.ps1 — Windows-native version of scripts/qa-loop.sh
#
# Runs the full daily QA loop in one shot:
#   1. node scripts/qa-prepare.js
#   2. claude -p  (non-interactive Claude Code session on scripts/qa-analyze.md)
#   3. node scripts/qa-commit.js
#
# Pre-reqs on the machine that runs this:
#   - Node.js installed and on PATH
#   - Claude Code CLI installed and authenticated (run `claude login` once)
#
# Manual run:     powershell -ExecutionPolicy Bypass -File scripts\qa-loop.ps1
# Task Scheduler: see docs/SCHEDULE_QA_LOOP_WINDOWS.md

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir   = Split-Path -Parent $scriptDir
Set-Location $repoDir

$logDir = Join-Path $repoDir "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logFile   = Join-Path $logDir "qa-loop-$timestamp.log"

function Log($msg) {
    $line = "$(Get-Date -Format 'HH:mm:ss') $msg"
    Write-Host $line
    Add-Content -Path $logFile -Value $line
}

Log "=== TCB QA loop starting ==="

# ── Step 1: prepare ──────────────────────────────────────────
Log "▶ qa-prepare"
& node scripts\qa-prepare.js 2>&1 | Tee-Object -FilePath $logFile -Append
if ($LASTEXITCODE -ne 0) { Log "qa-prepare failed"; exit 1 }

$manifestPath = Join-Path $repoDir "qa-queue\batch-manifest.json"
if (Test-Path $manifestPath) {
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $count    = $manifest.opportunities.Count
} else {
    $count = 0
}

if ($count -eq 0) {
    Log "No opportunities awaiting QA — done."
    exit 0
}
Log "$count opportunity/ies queued"

# ── Step 2: analyze (Claude Code, non-interactive) ───────────
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Log "claude CLI not found on PATH. Install from https://docs.claude.com/en/docs/claude-code"
    exit 1
}

$prompt = "Execute the workflow in the file scripts/qa-analyze.md exactly as written. Read the manifest at ./qa-queue/batch-manifest.json, analyze each opportunity folder under ./qa-queue/, and write a qa-report.json into each one. When done, print the summary the prompt asks for."

Log "▶ claude -p  (analyzing $count opportunities)"
& claude --print --max-turns 100 --dangerously-skip-permissions $prompt 2>&1 | Tee-Object -FilePath $logFile -Append
if ($LASTEXITCODE -ne 0) { Log "claude analysis failed (exit $LASTEXITCODE)"; exit 1 }

# ── Step 3: commit ───────────────────────────────────────────
Log "▶ qa-commit"
& node scripts\qa-commit.js 2>&1 | Tee-Object -FilePath $logFile -Append
if ($LASTEXITCODE -ne 0) { Log "qa-commit failed"; exit 1 }

Log "=== TCB QA loop finished ==="
