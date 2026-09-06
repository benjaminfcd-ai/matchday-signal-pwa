import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// During build (or if env vars are missing), fall back to a no-op client
// so the page still renders instead of crashing.
export const supabase =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: { persistSession: false },
        realtime: { params: { eventsPerSecond: 2 } },
      })
    : null;
