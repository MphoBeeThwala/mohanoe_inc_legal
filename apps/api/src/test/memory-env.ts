// Import this FIRST in a test file: it forces the in-memory datastore and a
// known firm brand before any service module reads process.env.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_KEY;
process.env.ALLOW_PUBLIC_REGISTRATION = 'true';
process.env.LOG_HTTP = 'false';
process.env.FIRM_NAME = 'Nkosi & Partners Inc.';
process.env.FIRM_SHORT_NAME = 'Nkosi';
process.env.FIRM_CASE_PREFIX = 'NKP';

export {};
