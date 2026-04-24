#!/usr/bin/env bash
# qa-loop.sh — runs the full daily QA loop in one shot.
#
#   1. qa-prepare.js         pulls awaiting_qa opps locally
#   2. claude -p …           non-interactive Claude Code session reads
#                            scripts/qa-analyze.md, analyzes the queue,
#                            writes qa-report.json per opp
#   3. qa-commit.js          pushes results back to Supabase, builds
#                            estimator packages, purges rejected opps
#
# Requires:
#   - `node` on PATH
#   - `claude` CLI on PATH, authenticated with Colin's OAuth (run
#     `claude login` once on the machine that'll be scheduled)
#
# Usage:
#   ./scripts/qa-loop.sh                 # runs normally
#   ./scripts/qa-loop.sh --skip-analyze  # useful when re-running commit
#   ./scripts/qa-loop.sh --skip-prepare  # useful when editing reports

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

LOG_DIR="$REPO_DIR/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/qa-loop-$(date +%Y%m%d-%H%M%S).log"

echo "=== TCB QA loop starting $(date) ===" | tee -a "$LOG"

SKIP_PREPARE=false
SKIP_ANALYZE=false
for arg in "$@"; do
  case "$arg" in
    --skip-prepare) SKIP_PREPARE=true ;;
    --skip-analyze) SKIP_ANALYZE=true ;;
  esac
done

# ── Step 1: prepare ──────────────────────────────────────────
if [ "$SKIP_PREPARE" = false ]; then
  echo "▶ qa-prepare" | tee -a "$LOG"
  node scripts/qa-prepare.js 2>&1 | tee -a "$LOG"

  # Count how many opps are queued — exit early if zero
  if [ -f ./qa-queue/batch-manifest.json ]; then
    COUNT=$(node -e "const m=require('./qa-queue/batch-manifest.json'); console.log(m.opportunities.length)")
  else
    COUNT=0
  fi
  if [ "$COUNT" = "0" ]; then
    echo "No opportunities awaiting QA — done." | tee -a "$LOG"
    exit 0
  fi
  echo "$COUNT opportunity/ies queued" | tee -a "$LOG"
fi

# ── Step 2: analyze (Claude Code) ────────────────────────────
if [ "$SKIP_ANALYZE" = false ]; then
  if ! command -v claude >/dev/null 2>&1; then
    echo "❌ 'claude' CLI not found on PATH." | tee -a "$LOG"
    echo "   Install: https://docs.claude.com/en/docs/claude-code" | tee -a "$LOG"
    exit 1
  fi

  echo "▶ claude -p scripts/qa-analyze.md" | tee -a "$LOG"

  # --max-turns is generous — complex packages may take 40+ tool calls.
  # --dangerously-skip-permissions so Claude can read/write within this
  # repo without prompting. Scoped to this working directory only.
  PROMPT="Execute the workflow in the file scripts/qa-analyze.md exactly as written. Read the manifest, analyze each opportunity in ./qa-queue/, and write qa-report.json files. When done, print the summary the prompt asks for."

  claude \
    --print \
    --max-turns 100 \
    --dangerously-skip-permissions \
    "$PROMPT" 2>&1 | tee -a "$LOG"
fi

# ── Step 3: commit ───────────────────────────────────────────
echo "▶ qa-commit" | tee -a "$LOG"
node scripts/qa-commit.js 2>&1 | tee -a "$LOG"

echo "=== TCB QA loop finished $(date) ===" | tee -a "$LOG"
