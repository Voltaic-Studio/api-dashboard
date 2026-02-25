import { createClient } from '@supabase/supabase-js';

export type Api = {
  id: string;
  title: string;
  description: string | null;
  logo: string | null;
  swagger_url: string | null;
  website: string | null;
  updated: string | null;
  doc_url: string | null;
  tldr: string | null;
  scrape_status: string | null;
};

export type Endpoint = {
  id: string;
  api_id: string;
  method: string;
  path: string;
  summary: string | null;
  description: string | null;
  parameters: any[] | null;
  responses: Record<string, any> | null;
  doc_url: string | null;
  section: string | null;
};

export type Brand = {
  id: string;
  title: string;
  description: string | null;
  logo: string | null;
  website: string | null;
  api_count: number;
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
