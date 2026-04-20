import { NextResponse, type NextRequest } from "next/server";

const SITE_ACCESS_COOKIE = "tcb_access";

/**
 * Single-gate auth: if SITE_ACCESS_CODE is set, every page request must
 * carry the matching cookie. No per-user accounts.
 *
 * Cron endpoints are excluded — they authenticate via Bearer token.
 * /unlock and /api/unlock must stay open so the gate is reachable.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Static + internal — always pass through
  if (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml"
  ) {
    return NextResponse.next();
  }

  // Cron endpoints authenticate via Authorization: Bearer — let them through
  if (pathname.startsWith("/api/cron/")) {
    return NextResponse.next();
  }

  const siteCode = process.env.SITE_ACCESS_CODE;
  if (!siteCode) {
    // No gate configured (local dev without env var) — let everything through.
    return NextResponse.next();
  }

  const isUnlockPath =
    pathname === "/unlock" || pathname.startsWith("/api/unlock");
  const hasAccess = request.cookies.get(SITE_ACCESS_COOKIE)?.value === siteCode;

  if (!hasAccess && !isUnlockPath) {
    const url = new URL("/unlock", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
