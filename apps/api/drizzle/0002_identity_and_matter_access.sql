-- Identity and matter access (roadmap epic 5).
-- 1. Sessions, invites, password resets and MFA recovery codes (all tenant
--    tables with forced RLS). 2. MFA, lockout and Entra (OIDC) columns on
--    users; password columns become optional for Entra-only accounts.
-- 3. Matter-level access: cases.access, case_members, case_exclusions
--    (ethical walls), and restrictive RLS policies for app_tenant so a hidden
--    matter's tasks, timeline, documents, invoices, ledger, calendar entries
--    and intake records are hidden with it.
--
-- Who is asking is read from transaction-local settings set by the API:
-- app.user_id and app.user_role (the signed-in user), or app.principal =
-- 'system' for platform jobs. With none of them set, no matter is visible.
CREATE TABLE "case_exclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "case_exclusions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "case_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"member_role" text DEFAULT 'member' NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "case_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mfa_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mfa_recovery_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "password_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_resets_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "password_resets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"method" text NOT NULL,
	"user_agent" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_salt" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "access" text DEFAULT 'firm' NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "case_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "oidc_issuer" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "oidc_subject" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_last_step" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "failed_login_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "case_exclusions" ADD CONSTRAINT "case_exclusions_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_exclusions" ADD CONSTRAINT "case_exclusions_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_exclusions" ADD CONSTRAINT "case_exclusions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_exclusions" ADD CONSTRAINT "case_exclusions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_members" ADD CONSTRAINT "case_members_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_members" ADD CONSTRAINT "case_members_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_members" ADD CONSTRAINT "case_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_members" ADD CONSTRAINT "case_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "case_exclusions_case_user_idx" ON "case_exclusions" USING btree ("case_id","user_id");--> statement-breakpoint
CREATE INDEX "case_exclusions_user_id_idx" ON "case_exclusions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "case_members_case_user_idx" ON "case_members" USING btree ("case_id","user_id");--> statement-breakpoint
CREATE INDEX "case_members_user_id_idx" ON "case_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invites_firm_email_idx" ON "invites" USING btree ("firm_id","email");--> statement-breakpoint
CREATE INDEX "mfa_recovery_codes_user_id_idx" ON "mfa_recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "password_resets_user_id_idx" ON "password_resets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_firm_oidc_idx" ON "users" USING btree ("firm_id","oidc_issuer","oidc_subject");--> statement-breakpoint
-- RLS is forced on these tables, so lift it for the owner while backfilling.
ALTER TABLE "submissions" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cases" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "submissions" s SET "case_id" = c."id" FROM "cases" c WHERE c."intake_submission_id" = s."id";
--> statement-breakpoint
ALTER TABLE "submissions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_case_visible(p_access text, p_case_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
	SELECT CASE
		WHEN current_setting('app.principal', true) = 'system' THEN true
		WHEN nullif(current_setting('app.user_id', true), '') IS NULL THEN false
		-- Ethical walls apply to everyone, admins included.
		WHEN EXISTS (
			SELECT 1 FROM public.case_exclusions e
			WHERE e.case_id = p_case_id AND e.user_id = nullif(current_setting('app.user_id', true), '')::uuid
		) THEN false
		WHEN p_access = 'firm' THEN true
		WHEN current_setting('app.user_role', true) = 'admin' THEN true
		ELSE EXISTS (
			SELECT 1 FROM public.case_members m
			WHERE m.case_id = p_case_id AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
		)
	END
$$;
--> statement-breakpoint
CREATE POLICY "assessments_matter_access" ON "assessments" AS RESTRICTIVE FOR ALL TO "app_tenant" USING (exists (select 1 from submissions s where s.id = assessments.intake_submission_id)) WITH CHECK (exists (select 1 from submissions s where s.id = assessments.intake_submission_id));--> statement-breakpoint
CREATE POLICY "calendar_events_matter_access" ON "calendar_events" AS RESTRICTIVE FOR ALL TO "app_tenant" USING (exists (select 1 from cases c where c.id = calendar_events.case_id)) WITH CHECK (exists (select 1 from cases c where c.id = calendar_events.case_id));--> statement-breakpoint
CREATE POLICY "case_tasks_matter_access" ON "case_tasks" AS RESTRICTIVE FOR ALL TO "app_tenant" USING (exists (select 1 from cases c where c.id = case_tasks.case_id)) WITH CHECK (exists (select 1 from cases c where c.id = case_tasks.case_id));--> statement-breakpoint
CREATE POLICY "case_timeline_matter_access" ON "case_timeline" AS RESTRICTIVE FOR ALL TO "app_tenant" USING (exists (select 1 from cases c where c.id = case_timeline.case_id)) WITH CHECK (exists (select 1 from cases c where c.id = case_timeline.case_id));--> statement-breakpoint
CREATE POLICY "cases_matter_access" ON "cases" AS RESTRICTIVE FOR ALL TO "app_tenant" USING (app_case_visible(access, id)) WITH CHECK (app_case_visible(access, id));--> statement-breakpoint
CREATE POLICY "documents_matter_access" ON "documents" AS RESTRICTIVE FOR ALL TO "app_tenant" USING (exists (select 1 from cases c where c.id = documents.case_id)) WITH CHECK (exists (select 1 from cases c where c.id = documents.case_id));--> statement-breakpoint
CREATE POLICY "billing_invoices_matter_access" ON "billing_invoices" AS RESTRICTIVE FOR ALL TO "app_tenant" USING (exists (select 1 from cases c where c.id = billing_invoices.case_id)) WITH CHECK (exists (select 1 from cases c where c.id = billing_invoices.case_id));--> statement-breakpoint
CREATE POLICY "billing_ledger_matter_access" ON "billing_ledger" AS RESTRICTIVE FOR ALL TO "app_tenant" USING (exists (select 1 from cases c where c.id = billing_ledger.case_id)) WITH CHECK (exists (select 1 from cases c where c.id = billing_ledger.case_id));--> statement-breakpoint
CREATE POLICY "submissions_matter_access" ON "submissions" AS RESTRICTIVE FOR ALL TO "app_tenant" USING (case_id is null or exists (select 1 from cases c where c.id = submissions.case_id)) WITH CHECK (case_id is null or exists (select 1 from cases c where c.id = submissions.case_id));--> statement-breakpoint
CREATE POLICY "case_exclusions_tenant_isolation" ON "case_exclusions" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "case_members_tenant_isolation" ON "case_members" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "invites_tenant_isolation" ON "invites" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "mfa_recovery_codes_tenant_isolation" ON "mfa_recovery_codes" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "password_resets_tenant_isolation" ON "password_resets" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sessions_tenant_isolation" ON "sessions" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mfa_recovery_codes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "invites" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "password_resets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "case_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "case_exclusions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "sessions", "mfa_recovery_codes", "invites", "password_resets", "case_members", "case_exclusions" TO app_tenant;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_case_visible(text, uuid) TO app_tenant;
