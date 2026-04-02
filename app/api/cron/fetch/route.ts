import { NextRequest, NextResponse } from 'next/server';
import { runFetchPipeline } from '@/lib/fetchers';

export async function GET(request: NextRequest) {
  // Verify cron secret (Vercel sends this header)
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runFetchPipeline(1); // last 24 hours
    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (err) {
    console.error('Cron fetch error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// Also allow POST for manual triggers
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Allow specifying days_back for initial backfill
  let daysBack = 1;
  try {
    const body = await request.json();
    if (body.days_back) daysBack = Math.min(body.days_back, 30);
  } catch {
    // No body or invalid JSON — use default
  }

  try {
    const result = await runFetchPipeline(daysBack);
    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (err) {
    console.error('Manual fetch error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
