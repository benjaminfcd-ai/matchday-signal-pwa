import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;

if (!url || !serviceKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set (as GitHub Actions secrets) for the scraper to write data."
  );
}

// Server-side only client using the secret key — never expose this key to
// the browser or commit it to the repo. It bypasses Row Level Security,
// which is exactly why only this script (not the public site) uses it.
export const supabaseAdmin = createClient(url, serviceKey, {
  auth: { persistSession: false },
});
