import { createClient } from '@supabase/supabase-js';
import { createBrowserClient as createSSRBrowserClient } from '@supabase/ssr';

// Server-side client with service role key (bypasses RLS)
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

// Browser-side client with anon key — uses @supabase/ssr so auth tokens
// are stored in cookies (not localStorage), matching the middleware.
export function createBrowserClient() {
  return createSSRBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
