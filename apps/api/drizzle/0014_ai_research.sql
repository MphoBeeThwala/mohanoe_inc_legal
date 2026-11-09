CREATE TABLE "ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"purpose" text NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"duration_ms" integer,
	"prompt_encrypted" text,
	"response_encrypted" text,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "research_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"question_encrypted" text NOT NULL,
	"brief_encrypted" text NOT NULL,
	"mapping_encrypted" text NOT NULL,
	"created_by" uuid,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_requests" ADD CONSTRAINT "research_requests_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_requests" ADD CONSTRAINT "research_requests_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_requests" ADD CONSTRAINT "research_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_requests" ADD CONSTRAINT "research_requests_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_calls_firm_month_idx" ON "ai_calls" USING btree ("firm_id","created_at");--> statement-breakpoint
CREATE INDEX "research_requests_case_idx" ON "research_requests" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE POLICY "ai_calls_tenant_isolation" ON "ai_calls" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "research_requests_tenant_isolation" ON "research_requests" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "research_requests_matter_access" ON "research_requests" AS RESTRICTIVE FOR ALL TO "app_tenant" USING (exists (select 1 from cases c where c.id = research_requests.case_id)) WITH CHECK (exists (select 1 from cases c where c.id = research_requests.case_id));--> statement-breakpoint
ALTER TABLE "ai_calls" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "research_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "ai_calls" TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "research_requests" TO app_tenant;
