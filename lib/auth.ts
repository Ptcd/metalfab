import { NextRequest } from 'next/server';

const SITE_ACCESS_COOKIE = 'tcb_access';

/**
 * Shared-password access check. Replaces the old per-user Supabase auth —
 * the only gate is the SITE_ACCESS_CODE cookie set by /api/unlock.
 *
 * Returns a pseudo-user object when the site code cookie is valid, null
 * otherwise. API routes treat null as 401.
 *
 * Cron endpoints don't use this — they check Authorization: Bearer directly.
 */
export async function getAuthUser(request: NextRequest) {
  const expected = process.env.SITE_ACCESS_CODE;
  if (!expected) {
    // Gate disabled (e.g. local dev without env) — treat as authed.
    return { id: 'local', role: 'site' };
  }
  const cookie = request.cookies.get(SITE_ACCESS_COOKIE)?.value;
  if (cookie === expected) {
    return { id: 'site', role: 'site' };
  }
  return null;
}
