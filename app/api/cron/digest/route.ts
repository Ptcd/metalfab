import { NextRequest, NextResponse } from 'next/server';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runDigest } = require('../../../../scripts/send-daily-digest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runCleanup } = require('../../../../scripts/cleanup-storage');

export const maxDuration = 60;

function authorized(req: NextRequest) {
  const header = req.headers.get('authorization');
  const secret = process.env.CRON_SECRET;
  return secret && header === `Bearer ${secret}`;
}

/**
 * Afternoon cron: send daily digest, then run storage cleanup.
 */
export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const startedAt = Date.now();
  const steps: Array<{ step: string; ms: number; result: unknown }> = [];

  try {
    const digestStart = Date.now();
    const digestResult = await runDigest();
    steps.push({ step: 'digest', ms: Date.now() - digestStart, result: digestResult });

    const cleanupStart = Date.now();
    const cleanupResult = await runCleanup();
    steps.push({ step: 'cleanup', ms: Date.now() - cleanupStart, result: cleanupResult });

    return NextResponse.json({ success: true, total_ms: Date.now() - startedAt, steps });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error', steps },
      { status: 500 }
    );
  }
}

export const POST = GET;
