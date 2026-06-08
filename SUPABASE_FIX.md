# Supabase database fixes

## Symptoms

| Error | Cause |
|-------|-------|
| `Could not find the 'is_active' column of 'users' in the schema cache` | `public.users` exists but is missing app columns |
| `Could not find the table 'public.submissions' in the schema cache` | Only partial SQL was run; operational tables were never created |
| `foreign key constraint "case_tasks_case_id_fkey" cannot be implemented` … `uuid and bigint` | Legacy `public.cases` (or `submissions`) already existed with **BIGINT** `id`; migration 002 skipped recreating it but created child tables with **UUID** `case_id` |
| API 500s on `/api/intake/*`, `/api/cases`, `/api/documents`, `/api/billing/*`, etc. | Same — backend expects the full schema in `backend/database.sql` |
| Frontend: "Operations data could not be loaded" | Operations hub calls many endpoints; all fail when tables are missing |

**Root cause:** The Supabase project was set up with a partial script (RLS loop and/or `001_users_schema_fix.sql`) but not the full application schema.

**ID types the app uses** (see `backend/services/intake.service.js`, `case.service.js`):

| Table / column | Type |
|----------------|------|
| `users.id` | `uuid` |
| `clients.id` | `bigint` (identity) |
| `submissions.id`, `assessments.id`, `cases.id` | `uuid` (`randomUUID()` in Node) |
| `case_tasks.case_id`, `documents.case_id`, etc. | `uuid` → `cases.id` |

Only `clients.id` is bigint. If an older Supabase template created `cases` with `BIGSERIAL`, migration 002 fails on the first child table (`case_tasks`).

---

## Fix FK type mismatch (`uuid` vs `bigint`) — run this first

If 002 failed with `case_tasks_case_id_fkey` / incompatible types:

1. In **Table Editor**, confirm `cases` has **no rows** you need (empty is required for the automatic fix).
2. Run [`backend/migrations/003_fix_case_id_types.sql`](backend/migrations/003_fix_case_id_types.sql) in SQL Editor.
3. Run [`backend/migrations/002_full_schema_bootstrap.sql`](backend/migrations/002_full_schema_bootstrap.sql) again.

003 drops empty legacy `cases` / `submissions` / `assessments` tables that have the wrong PK type, plus any partially created case child tables. It **refuses to drop** tables that still contain rows.

**Check current types** (optional):

```sql
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name IN ('submissions', 'assessments', 'cases') AND column_name = 'id')
    OR (table_name = 'cases' AND column_name = 'intake_submission_id')
    OR (table_name = 'case_tasks' AND column_name = 'case_id')
  )
ORDER BY table_name, column_name;
```

Expected: `uuid` for all rows except none of these should be `bigint`.

---

## Fix now (recommended)

Run **one** script in Supabase → **SQL Editor** → **New query** → **Run**:

**File:** [`backend/migrations/002_full_schema_bootstrap.sql`](backend/migrations/002_full_schema_bootstrap.sql)

This migration is idempotent. It:

- Creates all 15 app tables with `CREATE TABLE IF NOT EXISTS`
- Drops **empty** legacy tables whose `id` type does not match the app (e.g. bigint `cases`) before creating FKs
- Uses `gen_random_uuid()` for `users.id` (not `auth.uid()`)
- Backfills missing `users` columns (same as migration 001)
- Enables RLS on every table with **no policies** (backend uses the service role key)
- Ends with `NOTIFY pgrst, 'reload schema';`

After it succeeds, reload the deployed app and sign in again.

---

## Step-by-step (if you prefer two scripts)

1. **Only if registration fails on missing `users` columns** — run [`backend/migrations/001_users_schema_fix.sql`](backend/migrations/001_users_schema_fix.sql).
2. **If 002 failed on `case_tasks_case_id_fkey`** — run [`backend/migrations/003_fix_case_id_types.sql`](backend/migrations/003_fix_case_id_types.sql), then 002 again.
3. **Always run** — [`backend/migrations/002_full_schema_bootstrap.sql`](backend/migrations/002_full_schema_bootstrap.sql).

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
