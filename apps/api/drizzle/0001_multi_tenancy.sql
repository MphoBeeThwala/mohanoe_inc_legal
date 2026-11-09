-- Multi-tenancy (roadmap epic 4).
-- 1. firms table. 2. firm_id on every tenant table (existing rows are
-- backfilled into a 'default' firm). 3. Per-firm unique keys. 4. Forced
-- row-level security on every tenant table. 5. The restricted app_tenant role
-- that every request runs as (SET LOCAL ROLE), so RLS applies even when the
-- connecting user owns the tables.
CREATE TABLE "firms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"legal_name" text NOT NULL,
	"trading_name" text NOT NULL,
	"product_name" text,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"case_prefix" text DEFAULT 'MAT' NOT NULL,
	"domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"vat_number" text,
	"plan" text DEFAULT 'pilot' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firms_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
INSERT INTO "firms" ("slug", "legal_name", "trading_name")
SELECT 'default', 'Default firm', 'Default firm'
WHERE EXISTS (SELECT 1 FROM "users") OR EXISTS (SELECT 1 FROM "counters") OR EXISTS (SELECT 1 FROM "submissions") OR EXISTS (SELECT 1 FROM "assessments") OR EXISTS (SELECT 1 FROM "cases") OR EXISTS (SELECT 1 FROM "case_tasks") OR EXISTS (SELECT 1 FROM "case_timeline") OR EXISTS (SELECT 1 FROM "documents") OR EXISTS (SELECT 1 FROM "billing_invoices") OR EXISTS (SELECT 1 FROM "billing_ledger") OR EXISTS (SELECT 1 FROM "calendar_events") OR EXISTS (SELECT 1 FROM "notifications") OR EXISTS (SELECT 1 FROM "audit_events") OR EXISTS (SELECT 1 FROM "report_snapshots") OR EXISTS (SELECT 1 FROM "compliance_requests");
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "firm_id" uuid;
--> statement-breakpoint
UPDATE "users" SET "firm_id" = (SELECT "id" FROM "firms" WHERE "slug" = 'default');
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "firm_id" SET DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "firm_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "counters" ADD COLUMN "firm_id" uuid;
--> statement-breakpoint
UPDATE "counters" SET "firm_id" = (SELECT "id" FROM "firms" WHERE "slug" = 'default');
--> statement-breakpoint
ALTER TABLE "counters" ALTER COLUMN "firm_id" SET DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "counters" ALTER COLUMN "firm_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "counters" ADD CONSTRAINT "counters_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "firm_id" uuid;
--> statement-breakpoint
UPDATE "submissions" SET "firm_id" = (SELECT "id" FROM "firms" WHERE "slug" = 'default');
--> statement-breakpoint
ALTER TABLE "submissions" ALTER COLUMN "firm_id" SET DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "submissions" ALTER COLUMN "firm_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "firm_id" uuid;
--> statement-breakpoint
UPDATE "assessments" SET "firm_id" = (SELECT "id" FROM "firms" WHERE "slug" = 'default');
--> statement-breakpoint
ALTER TABLE "assessments" ALTER COLUMN "firm_id" SET DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "assessments" ALTER COLUMN "firm_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "firm_id" uuid;
--> statement-breakpoint
UPDATE "cases" SET "firm_id" = (SELECT "id" FROM "firms" WHERE "slug" = 'default');
--> statement-breakpoint
ALTER TABLE "cases" ALTER COLUMN "firm_id" SET DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "cases" ALTER COLUMN "firm_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "case_tasks" ADD COLUMN "firm_id" uuid;
--> statement-breakpoint
UPDATE "case_tasks" SET "firm_id" = (SELECT "id" FROM "firms" WHERE "slug" = 'default');
--> statement-breakpoint
ALTER TABLE "case_tasks" ALTER COLUMN "firm_id" SET DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "case_tasks" ALTER COLUMN "firm_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "case_tasks" ADD CONSTRAINT "case_tasks_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "case_timeline" ADD COLUMN "firm_id" uuid;
--> statement-breakpoint
UPDATE "case_timeline" SET "firm_id" = (SELECT "id" FROM "firms" WHERE "slug" = 'default');
--> statement-breakpoint
ALTER TABLE "case_timeline" ALTER COLUMN "firm_id" SET DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "case_timeline" ALTER COLUMN "firm_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "case_timeline" ADD CONSTRAINT "case_timeline_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "firm_id" uuid;
--> statement-breakpoint
UPDATE "documents" SET "firm_id" = (SELECT "id" FROM "firms" WHERE "slug" = 'default');
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "firm_id" SET DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "firm_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD COLUMN "firm_id" uuid;
--> statement-breakpoint
UPDATE "billing_invoices" SET "firm_id" = (SELECT "id" FROM "firms" WHERE "slug" = 'default');
--> statement-breakpoint
ALTER TABLE "billing_invoices" ALTER COLUMN "firm_id" SET DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "billing_invoices" ALTER COLUMN "firm_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_ledger" ADD COLUMN "firm_id" uuid;
--> statement-breakpoint
UPDATE "billing_ledger" SET "firm_id" = (SELECT "id" FROM "firms" WHERE "slug" = 'default');
--> statement-breakpoint
ALTER TABLE "billing_ledger" ALTER COLUMN "firm_id" SET DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "billing_ledger" ALTER COLUMN "firm_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "billing_ledger" ADD CONSTRAINT "billing_ledger_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "firm_id" uuid;
--> statement-breakpoint
UPDATE "calendar_events" SET "firm_id" = (SELECT "id" FROM "firms" WHERE "slug" = 'default');
--> statement-breakpoint
ALTER TABLE "calendar_events" ALTER COLUMN "firm_id" SET DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "calendar_events" ALTER COLUMN "firm_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "firm_id" uuid;
--> statement-breakpoint
UPDATE "notifications" SET "firm_id" = (SELECT "id" FROM "firms" WHERE "slug" = 'default');
--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "firm_id" SET DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "firm_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "firm_id" uuid;
--> statement-breakpoint
UPDATE "audit_events" SET "firm_id" = (SELECT "id" FROM "firms" WHERE "slug" = 'default');
--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "firm_id" SET DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "firm_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD COLUMN "firm_id" uuid;
--> statement-breakpoint
UPDATE "report_snapshots" SET "firm_id" = (SELECT "id" FROM "firms" WHERE "slug" = 'default');
--> statement-breakpoint
ALTER TABLE "report_snapshots" ALTER COLUMN "firm_id" SET DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "report_snapshots" ALTER COLUMN "firm_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "compliance_requests" ADD COLUMN "firm_id" uuid;
--> statement-breakpoint
UPDATE "compliance_requests" SET "firm_id" = (SELECT "id" FROM "firms" WHERE "slug" = 'default');
--> statement-breakpoint
ALTER TABLE "compliance_requests" ALTER COLUMN "firm_id" SET DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "compliance_requests" ALTER COLUMN "firm_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "compliance_requests" ADD CONSTRAINT "compliance_requests_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "counters" DROP CONSTRAINT "counters_pkey";
--> statement-breakpoint
ALTER TABLE "counters" ADD CONSTRAINT "counters_firm_id_name_pk" PRIMARY KEY("firm_id","name");
--> statement-breakpoint
ALTER TABLE "cases" DROP CONSTRAINT "cases_case_number_unique";
--> statement-breakpoint
ALTER TABLE "billing_invoices" DROP CONSTRAINT "billing_invoices_invoice_number_unique";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_email_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "cases_firm_case_number_idx" ON "cases" USING btree ("firm_id","case_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_invoices_firm_number_idx" ON "billing_invoices" USING btree ("firm_id","invoice_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "users_firm_email_idx" ON "users" USING btree ("firm_id","email");
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "users_tenant_isolation" ON "users" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "counters" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "counters" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "counters_tenant_isolation" ON "counters" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "submissions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "submissions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "submissions_tenant_isolation" ON "submissions" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "assessments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "assessments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "assessments_tenant_isolation" ON "assessments" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "cases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "cases_tenant_isolation" ON "cases" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "case_tasks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "case_tasks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "case_tasks_tenant_isolation" ON "case_tasks" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "case_timeline" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "case_timeline" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "case_timeline_tenant_isolation" ON "case_timeline" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "documents_tenant_isolation" ON "documents" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "billing_invoices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "billing_invoices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "billing_invoices_tenant_isolation" ON "billing_invoices" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "billing_ledger" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "billing_ledger" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "billing_ledger_tenant_isolation" ON "billing_ledger" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "calendar_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "calendar_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "calendar_events_tenant_isolation" ON "calendar_events" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notifications_tenant_isolation" ON "notifications" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audit_events_tenant_isolation" ON "audit_events" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "report_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "report_snapshots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "report_snapshots_tenant_isolation" ON "report_snapshots" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "compliance_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "compliance_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "compliance_requests_tenant_isolation" ON "compliance_requests" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
		CREATE ROLE app_tenant NOLOGIN NOINHERIT;
	END IF;
	-- The application switches to app_tenant per request (SET LOCAL ROLE), so
	-- the migrating/connecting user must be a member of it.
	BEGIN
		EXECUTE format('GRANT app_tenant TO %I', current_user);
	EXCEPTION WHEN insufficient_privilege THEN
		IF NOT pg_has_role(current_user, 'app_tenant', 'MEMBER') THEN
			RAISE EXCEPTION 'Role app_tenant already exists and % cannot be granted it. Ask a database administrator to run: GRANT app_tenant TO %;', current_user, current_user;
		END IF;
	END;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_tenant;
--> statement-breakpoint
GRANT SELECT ON "firms" TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "users", "counters", "submissions", "assessments", "cases", "case_tasks", "case_timeline", "documents", "billing_invoices", "billing_ledger", "calendar_events", "notifications", "audit_events", "report_snapshots", "compliance_requests" TO app_tenant;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_tenant;
