import { NextRequest, NextResponse } from 'next/server';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runCleanup } = require('../../../../scripts/cleanup-storage');

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const dryRun = searchParams.get('dry') === '1' || searchParams.get('dry_run') === '1';
  const force = searchParams.get('force') === '1';
  try {
    const result = await runCleanup({ dryRun, force });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export const POST = GET;
