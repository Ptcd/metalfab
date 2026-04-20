import { NextRequest, NextResponse } from 'next/server';
import { runFetchPipeline } from '@/lib/fetchers';

export const maxDuration = 900;

/**
 * Manual trigger: run only the HTTP scrapers (SAM.gov etc.). No doc download,
 * no digest, no cleanup. For debugging an individual step.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const result = await runFetchPipeline(1);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export const POST = GET;
