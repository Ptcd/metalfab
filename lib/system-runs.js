/**
 * lib/system-runs.js — record cron and Claude Code runs for observability.
 * Usage:
 *   const run = await startRun('scrape');
 *   await addStep(run, 'fetch-samgov', { duration_ms: 1234 });
 *   await finishRun(run, { status: 'success', opportunities_processed: 12 });
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function startRun(run_type, notes = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/system_runs`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'return=representation' },
    body: JSON.stringify({ run_type, notes }),
  });
  const arr = await res.json();
  return Array.isArray(arr) ? arr[0] : arr;
}

async function addStep(run, step, extra = {}) {
  if (!run || !run.id) return;
  const steps = Array.isArray(run.steps_completed) ? run.steps_completed : [];
  steps.push({ step, at: new Date().toISOString(), ...extra });
  run.steps_completed = steps;
  await fetch(`${SUPABASE_URL}/rest/v1/system_runs?id=eq.${run.id}`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify({ steps_completed: steps }),
  });
}

async function addError(run, step, error) {
  if (!run || !run.id) return;
  const errors = Array.isArray(run.errors_encountered) ? run.errors_encountered : [];
  errors.push({
    step,
    at: new Date().toISOString(),
    message: typeof error === 'string' ? error : error?.message || String(error),
  });
  run.errors_encountered = errors;
  await fetch(`${SUPABASE_URL}/rest/v1/system_runs?id=eq.${run.id}`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify({ errors_encountered: errors }),
  });
}

async function finishRun(run, patch = {}) {
  if (!run || !run.id) return;
  const payload = {
    ended_at: new Date().toISOString(),
    status: patch.status || (run.errors_encountered?.length ? 'partial' : 'success'),
    ...patch,
  };
  await fetch(`${SUPABASE_URL}/rest/v1/system_runs?id=eq.${run.id}`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify(payload),
  });
}

module.exports = { startRun, addStep, addError, finishRun };
