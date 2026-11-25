import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
export const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey);

if (import.meta.env.DEV && supabaseUrl) {
  try {
    console.info(`ArtGuard Supabase project hostname: ${new URL(supabaseUrl).hostname}`);
  } catch {
    console.warn('ArtGuard Supabase project hostname is unavailable because VITE_SUPABASE_URL is invalid.');
  }
}

export const supabaseConfigError = !supabaseUrl
  ? 'Missing VITE_SUPABASE_URL. Create .env.local in the artguard folder.'
  : !supabasePublishableKey
    ? 'Missing VITE_SUPABASE_PUBLISHABLE_KEY. Create .env.local in the artguard folder.'
    : null;

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabasePublishableKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'implicit',
      },
    })
  : null;

export const supabaseConfigurationStatus = Object.freeze({
  urlPresent: Boolean(supabaseUrl),
  publishableKeyPresent: Boolean(supabasePublishableKey),
  clientInitialized: supabase !== null,
});
