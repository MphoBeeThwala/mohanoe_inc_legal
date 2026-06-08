-- ====================================================================
-- Migration 003: Fix UUID / bigint mismatch on cases and dependents
-- Run when 002 failed with:
--   foreign key constraint "case_tasks_case_id_fkey" cannot be implemented
--   DETAIL: Key columns "case_id" and "id" are of incompatible types: uuid and bigint
--
-- Cause: public.cases already existed with BIGINT id (legacy/template schema).
--        CREATE TABLE IF NOT EXISTS in 002 skipped cases but still tried to
--        create case_tasks with UUID case_id → FK type error.
--
-- Safe when cases/submissions/assessments are empty (typical partial bootstrap).
-- If tables contain data, this script raises an error instead of dropping.
--
-- After this succeeds, re-run 002_full_schema_bootstrap.sql (idempotent).
-- ====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public._mohanoe_column_type(p_table text, p_column text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT c.data_type
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = p_table
    AND c.column_name = p_column
$$;

CREATE OR REPLACE FUNCTION public._mohanoe_drop_empty_wrong_pk(
  p_table text,
  p_expected_type text DEFAULT 'uuid'
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  actual_type text;
  row_count bigint;
BEGIN
  IF to_regclass('public.' || p_table) IS NULL THEN
    RETURN;
  END IF;

  actual_type := public._mohanoe_column_type(p_table, 'id');
  IF actual_type IS NULL OR actual_type = p_expected_type THEN
    RETURN;
  END IF;

  EXECUTE format('SELECT COUNT(*) FROM public.%I', p_table) INTO row_count;
  IF row_count > 0 THEN
    RAISE EXCEPTION
      'public.% has id type % (% rows). App requires %. Export data, truncate, or migrate manually.',
      p_table, actual_type, row_count, p_expected_type;
  END IF;

  EXECUTE format('DROP TABLE public.%I CASCADE', p_table);
  RAISE NOTICE 'Dropped empty public.% (id was %, expected %)', p_table, actual_type, p_expected_type;
END;
$$;

CREATE OR REPLACE FUNCTION public._mohanoe_drop_case_dependents()
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  DROP TABLE IF EXISTS public.calendar_events CASCADE;
  DROP TABLE IF EXISTS public.billing_ledger CASCADE;
  DROP TABLE IF EXISTS public.billing_invoices CASCADE;
  DROP TABLE IF EXISTS public.documents CASCADE;
  DROP TABLE IF EXISTS public.case_timeline CASCADE;
  DROP TABLE IF EXISTS public.case_tasks CASCADE;
END;
$$;

-- Remove any partially created case child tables (may not exist if 002 failed early).
SELECT public._mohanoe_drop_case_dependents();

DO $$
DECLARE
  submissions_id_type text;
  cases_id_type text;
BEGIN
  submissions_id_type := public._mohanoe_column_type('submissions', 'id');
  cases_id_type := public._mohanoe_column_type('cases', 'id');

  IF submissions_id_type IS NOT NULL AND submissions_id_type <> 'uuid' THEN
    PERFORM public._mohanoe_drop_empty_wrong_pk('cases');
    PERFORM public._mohanoe_drop_empty_wrong_pk('assessments');
    PERFORM public._mohanoe_drop_empty_wrong_pk('submissions');
  END IF;

  IF cases_id_type IS NOT NULL AND cases_id_type <> 'uuid' THEN
    PERFORM public._mohanoe_drop_empty_wrong_pk('cases');
  END IF;

  IF public._mohanoe_column_type('assessments', 'intake_submission_id') IS NOT NULL
     AND public._mohanoe_column_type('assessments', 'intake_submission_id') <> 'uuid' THEN
    PERFORM public._mohanoe_drop_empty_wrong_pk('assessments');
  END IF;

  IF public._mohanoe_column_type('cases', 'intake_submission_id') IS NOT NULL
     AND public._mohanoe_column_type('cases', 'intake_submission_id') <> 'uuid' THEN
    PERFORM public._mohanoe_drop_empty_wrong_pk('cases');
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- Next step: run backend/migrations/002_full_schema_bootstrap.sql in the same SQL Editor.
