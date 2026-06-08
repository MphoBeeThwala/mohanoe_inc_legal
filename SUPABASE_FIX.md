# Supabase: fix "Could not find the 'is_active' column of 'users'"

## Root cause

Account registration fails with a 500 and PostgREST error:

`Could not find the 'is_active' column of 'users' in the schema cache`

The backend inserts into `public.users` using snake_case columns defined in `backend/database.sql`. If the Supabase project was created from an older or partial schema, columns such as `is_active` may be missing even though the app expects them.

## Fix now (Supabase SQL Editor)

1. Open your Supabase project → **SQL Editor** → **New query**.
2. Paste the block below and click **Run**.
3. Retry **Create account** in the app.

```sql
-- Idempotent: safe to run more than once
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'client';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_salt TEXT NOT NULL DEFAULT '';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

UPDATE public.users SET is_active = TRUE WHERE is_active IS NULL;

NOTIFY pgrst, 'reload schema';
```

## Columns the app expects on `public.users`

| Column | Used for |
|--------|----------|
| `id` | Primary key (UUID) |
| `email` | Login and uniqueness |
| `full_name` | Display name |
| `role` | `attorney`, `admin`, etc. |
| `password_hash` | Scrypt password hash |
| `password_salt` | Scrypt salt |
| `is_active` | Block deactivated accounts |
| `created_at` | Registration timestamp |
| `last_login_at` | Updated on each login |

Canonical definition: `backend/database.sql` (users table).  
Repeatable migration: `backend/migrations/001_users_schema_fix.sql`.

## Fresh database

For a new environment, run the full `backend/database.sql` in the SQL Editor instead of only this patch.
