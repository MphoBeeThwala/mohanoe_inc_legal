-- ====================================================================
-- Migration 001: Align public.users with app expectations
-- Safe to run multiple times on an existing Supabase database.
-- Run in Supabase SQL Editor or via psql against your project DB.
-- ====================================================================

-- App auth (backend/services/auth.service.js) reads/writes these columns:
--   id, email, full_name, role, password_hash, password_salt,
--   is_active, created_at, last_login_at

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'client';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_salt TEXT NOT NULL DEFAULT '';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- Backfill is_active for any rows created before the column existed.
UPDATE public.users SET is_active = TRUE WHERE is_active IS NULL;

-- Ask PostgREST to reload its schema cache (fixes "column not in schema cache").
NOTIFY pgrst, 'reload schema';
