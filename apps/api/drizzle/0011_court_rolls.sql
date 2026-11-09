-- Court roll sync (roadmap epic 7): published rolls (platform tables with no
-- tenant access; case numbers only, no party names) and per-firm matches.
CREATE TABLE "court_roll_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"division" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"roll_date" date,
	"content_hash" text NOT NULL,
	"content_type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"superseded_by" uuid,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "court_roll_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"division" text NOT NULL,
	"case_key" text NOT NULL,
	"hearing_date" date,
	"hearing_time" text,
	"courtroom" text,
	"judge" text,
	"section" text
);
--> statement-breakpoint
CREATE TABLE "court_roll_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"document_ref" text NOT NULL,
	"document_title" text NOT NULL,
	"division" text NOT NULL,
	"hearing_date" date,
	"hearing_time" text,
	"courtroom" text,
	"judge" text,
	"section" text,
	"listing_key" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"event_id" uuid,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "court_roll_matches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "court_roll_entries" ADD CONSTRAINT "court_roll_entries_document_id_court_roll_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."court_roll_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_roll_matches" ADD CONSTRAINT "court_roll_matches_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_roll_matches" ADD CONSTRAINT "court_roll_matches_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_roll_matches" ADD CONSTRAINT "court_roll_matches_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_roll_matches" ADD CONSTRAINT "court_roll_matches_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "court_roll_documents_version_idx" ON "court_roll_documents" USING btree ("url","content_hash");--> statement-breakpoint
CREATE INDEX "court_roll_documents_division_idx" ON "court_roll_documents" USING btree ("division","roll_date");--> statement-breakpoint
CREATE INDEX "court_roll_entries_case_idx" ON "court_roll_entries" USING btree ("division","case_key");--> statement-breakpoint
CREATE UNIQUE INDEX "court_roll_matches_listing_idx" ON "court_roll_matches" USING btree ("case_id","listing_key");--> statement-breakpoint
CREATE INDEX "court_roll_matches_status_idx" ON "court_roll_matches" USING btree ("status");--> statement-breakpoint
CREATE POLICY "court_roll_matches_tenant_isolation" ON "court_roll_matches" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "court_roll_matches_matter_access" ON "court_roll_matches" AS RESTRICTIVE FOR ALL TO "app_tenant" USING (exists (select 1 from cases c where c.id = court_roll_matches.case_id)) WITH CHECK (exists (select 1 from cases c where c.id = court_roll_matches.case_id));--> statement-breakpoint
REVOKE ALL ON "court_roll_documents", "court_roll_entries" FROM app_tenant;
--> statement-breakpoint
ALTER TABLE "court_roll_matches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "court_roll_matches" TO app_tenant;
