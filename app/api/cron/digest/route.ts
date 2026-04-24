import { NextRequest, NextResponse } from 'next/server';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runDigest } = require('../../../../scripts/send-daily-digest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runCleanup } = require('../../../../scripts/cleanup-storage');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runSeedReminders } = require('../../../../scripts/seed-reminders');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runCheckAwards } = require('../../../../scripts/check-awards');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runWeeklyReport } = require('../../../../scripts/send-weekly-report');

export const maxDuration = 60;

function authorized(req: NextRequest) {
  const header = req.headers.get('authorization');
  const secret = process.env.CRON_SECRET;
  return secret && header === `Bearer ${secret}`;
}

/**
 * Afternoon cron sequence:
 *   1. seed-reminders — deadline + pre-bid meeting reminders
 *   2. check-awards — SAM.gov award-notice scan, flips rebid reminders
 *   3. digest — Brevo email to estimator
 *   4. cleanup — time-based doc purge
 * Each step independently try/catch — one failure doesn't block the rest.
 */
async function runStep(name: string, fn: () => Promise<unknown>) {
  const start = Date.now();
  try {
    const result = await fn();
    return { step: name, ms: Date.now() - start, result };
  } catch (err) {
    return {
      step: name,
      ms: Date.now() - start,
      result: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const startedAt = Date.now();
  const steps = [
    await runStep('seed-reminders', runSeedReminders),
    await runStep('check-awards', runCheckAwards),
    await runStep('digest', runDigest),
    await runStep('weekly-report', runWeeklyReport), // no-ops on non-Fridays
    await runStep('cleanup', runCleanup),
  ];
  return NextResponse.json({
    success: true,
    total_ms: Date.now() - startedAt,
    steps,
  });
}

export const POST = GET;
