import { NextRequest, NextResponse } from 'next/server';
import { runFetchPipeline } from '@/lib/fetchers';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runFetchDocs } = require('../../../../scripts/fetch-docs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runFetchEmail } = require('../../../../scripts/fetch-email');

export const maxDuration = 60;

function authorized(req: NextRequest) {
  const header = req.headers.get('authorization');
  const secret = process.env.CRON_SECRET;
  return secret && header === `Bearer ${secret}`;
}

/**
 * Morning cron:
 *   1. Scrape SAM.gov (and other HTTP-only sources wired into runFetchPipeline)
 *   2. fetch-docs.js — download bid documents for opportunities above threshold
 *      and promote them to awaiting_qa
 *
 * Puppeteer-based scrapers (BidNet, Bonfire, etc.) still run locally via
 * scripts/run-pipeline.js — Vercel serverless can't bundle headful Chromium.
 */
async function runMorning(daysBack: number) {
  const startedAt = Date.now();
  const steps: Array<{ step: string; ms: number; result?: unknown }> = [];

  const scrapeStart = Date.now();
  const fetchResult = await runFetchPipeline(daysBack);
  steps.push({ step: 'scrape', ms: Date.now() - scrapeStart, result: fetchResult });

  // Inbound email — pull any bid notifications that landed in the AOL Bids folder
  let emailResult: unknown = { skipped: true };
  try {
    const emailStart = Date.now();
    emailResult = await runFetchEmail();
    steps.push({ step: 'fetch-email', ms: Date.now() - emailStart, result: emailResult });
  } catch (err) {
    steps.push({
      step: 'fetch-email',
      ms: 0,
      result: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  let docsResult: unknown = { skipped: true };
  try {
    const docsStart = Date.now();
    docsResult = await runFetchDocs();
    steps.push({ step: 'fetch-docs', ms: Date.now() - docsStart, result: docsResult });
  } catch (err) {
    steps.push({
      step: 'fetch-docs',
      ms: 0,
      result: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  return {
    success: true,
    total_ms: Date.now() - startedAt,
    steps,
    scrape: fetchResult,
    email: emailResult,
    docs: docsResult,
  };
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    return NextResponse.json(await runMorning(1));
  } catch (err) {
    console.error('Cron fetch error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let daysBack = 1;
  try {
    const body = await request.json();
    if (body.days_back) daysBack = Math.min(body.days_back, 30);
  } catch {
    // no body
  }
  try {
    return NextResponse.json(await runMorning(daysBack));
  } catch (err) {
    console.error('Manual fetch error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
