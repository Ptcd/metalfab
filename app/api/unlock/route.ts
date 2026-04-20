import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const COOKIE = "tcb_access";
const ONE_YEAR = 60 * 60 * 24 * 365;

export async function POST(request: NextRequest) {
  const expected = process.env.SITE_ACCESS_CODE;
  if (!expected) {
    // No gate configured — treat as open
    return NextResponse.json({ ok: true, gate: "disabled" });
  }

  let body: { code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if ((body.code || "").trim() !== expected) {
    return NextResponse.json({ error: "Incorrect code" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, expected, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: ONE_YEAR,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
