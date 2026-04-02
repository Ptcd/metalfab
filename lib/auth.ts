import { createServerClient } from '@supabase/ssr';
import { NextRequest } from 'next/server';

/**
 * Extract the authenticated user from request cookies.
 * Returns the user object if authenticated, or null if not.
 */
export async function getAuthUser(request: NextRequest) {
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        // Server client in API routes is read-only for cookies
        setAll() {},
      },
    }
  );

  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return null;
  }

  return user;
}
