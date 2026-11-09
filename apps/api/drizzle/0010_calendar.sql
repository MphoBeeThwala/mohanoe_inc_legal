-- Calendar (roadmap epic 7): court details on matters, encrypted event content,
-- event status, source, assignee and reminders, and prescription periods.
CREATE TABLE "matter_prescriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"starts_on" date NOT NULL,
	"last_day" date NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"notes_encrypted" text,
	"event_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "matter_prescriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_events" ALTER COLUMN "title" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "all_day" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "content_encrypted" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "status" text DEFAULT 'scheduled' NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "assignee_user_id" uuid;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "reminder_offsets" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "reminders_sent" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "court_division" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "court_case_number" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "court_case_key" text;--> statement-breakpoint
ALTER TABLE "matter_prescriptions" ADD CONSTRAINT "matter_prescriptions_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_prescriptions" ADD CONSTRAINT "matter_prescriptions_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_prescriptions" ADD CONSTRAINT "matter_prescriptions_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_prescriptions" ADD CONSTRAINT "matter_prescriptions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "matter_prescriptions_case_idx" ON "matter_prescriptions" USING btree ("case_id");--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_events_status_idx" ON "calendar_events" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "cases_court_case_key_idx" ON "cases" USING btree ("court_division","court_case_key");--> statement-breakpoint
CREATE POLICY "matter_prescriptions_tenant_isolation" ON "matter_prescriptions" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "matter_prescriptions_matter_access" ON "matter_prescriptions" AS RESTRICTIVE FOR ALL TO "app_tenant" USING (exists (select 1 from cases c where c.id = matter_prescriptions.case_id)) WITH CHECK (exists (select 1 from cases c where c.id = matter_prescriptions.case_id));--> statement-breakpoint
ALTER TABLE "matter_prescriptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "matter_prescriptions" TO app_tenant;
