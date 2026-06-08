# Supabase database fixes

## Symptoms

| Error | Cause |
|-------|-------|
| `Could not find the 'is_active' column of 'users' in the schema cache` | `public.users` exists but is missing app columns |
| `Could not find the table 'public.submissions' in the schema cache` | Only partial SQL was run; operational tables were never created |
| API 500s on `/api/intake/*`, `/api/cases`, `/api/documents`, `/api/billing/*`, etc. | Same — backend expects the full schema in `backend/database.sql` |
| Frontend: "Operations data could not be loaded" | Operations hub calls many endpoints; all fail when tables are missing |

**Root cause:** The Supabase project was set up with a partial script (RLS loop and/or `001_users_schema_fix.sql`) but not the full application schema.

---

## Fix now (recommended)

Run **one** script in Supabase → **SQL Editor** → **New query** → **Run**:

**File:** [`backend/migrations/002_full_schema_bootstrap.sql`](backend/migrations/002_full_schema_bootstrap.sql)

This migration is idempotent. It:

- Creates all 15 app tables with `CREATE TABLE IF NOT EXISTS`
- Uses `gen_random_uuid()` for `users.id` (not `auth.uid()`)
- Backfills missing `users` columns (same as migration 001)
- Enables RLS on every table with **no policies** (backend uses the service role key)
- Ends with `NOTIFY pgrst, 'reload schema';`

After it succeeds, reload the deployed app and sign in again.

---

## Step-by-step (if you prefer two scripts)

1. **Only if registration fails on missing `users` columns** — run [`backend/migrations/001_users_schema_fix.sql`](backend/migrations/001_users_schema_fix.sql).
2. **Always run next** — [`backend/migrations/002_full_schema_bootstrap.sql`](backend/migrations/002_full_schema_bootstrap.sql).

You do **not** need to run `backend/database.sql` if you run 002; 002 is the idempotent production bootstrap.

---

## Combined one-paste script

Paste the entire contents of `backend/migrations/002_full_schema_bootstrap.sql` into the SQL Editor. That single run fixes both missing columns and missing tables.

---

## Fresh database

For a brand-new Supabase project with no tables yet, running `002_full_schema_bootstrap.sql` once is sufficient. The canonical reference schema remains `backend/database.sql` (includes example RLS policies for direct client access; production uses service role + zero policies).

---

## Columns the app expects on `public.users`

| Column | Used for |
|--------|----------|
| `id` | Primary key (UUID, `gen_random_uuid()`) |
| `email` | Login and uniqueness |
| `full_name` | Display name |
| `role` | `attorney`, `admin`, etc. |
| `password_hash` | Scrypt password hash |
| `password_salt` | Scrypt salt |
| `is_active` | Block deactivated accounts |
| `created_at` | Registration timestamp |
| `last_login_at` | Updated on each login |

---

## Tables created by migration 002

`users`, `clients`, `submissions`, `assessments`, `cases`, `case_tasks`, `case_timeline`, `documents`, `billing_invoices`, `billing_ledger`, `calendar_events`, `audit_events`, `notifications`, `report_snapshots`, `compliance_requests`

---

## Verify

In Supabase → **Table Editor**, confirm `submissions` and `cases` exist. Then hit `/ready` on your Render service — `configured` should be `true` when env vars are set.
