import { createClient } from '@supabase/supabase-js';

export type Api = {
  id: string;
  title: string;
  description: string | null;
  logo: string | null;
  swagger_url: string | null;
  website: string | null;
  updated: string | null;
};

/**
 * Server-side Supabase client.
 * Called in Server Components and API routes only — never imported in 'use client' files.
 */
export function createServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }

  return createClient<{ public: { Tables: { apis: { Row: Api } } } }>(url, key);
}
