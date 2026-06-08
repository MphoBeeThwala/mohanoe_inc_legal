
const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;

function getSupabaseClient() {
  if (cachedClient) {
    return cachedClient;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl && !supabaseKey) {
    return null;
  }

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      'Supabase persistence requires both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
    );
  }

  cachedClient = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return cachedClient;
}

module.exports = {
  getSupabaseClient,
};
