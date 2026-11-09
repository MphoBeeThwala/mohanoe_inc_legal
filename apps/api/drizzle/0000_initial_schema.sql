CREATE TABLE "assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intake_submission_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model_name" text NOT NULL,
	"matter_type" text NOT NULL,
	"urgency" text NOT NULL,
	"summary" text NOT NULL,
	"key_facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attorney_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommended_documents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compliance_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" numeric(4, 2) DEFAULT 0 NOT NULL,
	"popia_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_redacted_brief" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessments_intake_submission_id_unique" UNIQUE("intake_submission_id")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"actor_name" text NOT NULL,
	"actor_role" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"action" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"previous_hash" text NOT NULL,
	"entry_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"case_number" text NOT NULL,
	"title" text NOT NULL,
	"event_type" text DEFAULT 'deadline' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"location" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"due_date" date,
	"assignee_name" text,
	"created_by" text NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_timeline" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"event_type" text DEFAULT 'note' NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intake_submission_id" uuid NOT NULL,
	"case_number" text NOT NULL,
	"client_label" text NOT NULL,
	"practice_area" text NOT NULL,
	"urgency" text NOT NULL,
	"status" text DEFAULT 'triage' NOT NULL,
	"next_action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cases_intake_submission_id_unique" UNIQUE("intake_submission_id"),
	CONSTRAINT "cases_case_number_unique" UNIQUE("case_number")
);
--> statement-breakpoint
CREATE TABLE "compliance_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_type" text DEFAULT 'access' NOT NULL,
	"subject_name" text NOT NULL,
	"subject_email" text NOT NULL,
	"case_ref" text,
	"description" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"response_summary" text DEFAULT '' NOT NULL,
	"response_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"due_at" timestamp with time zone,
	"fulfilled_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counters" (
	"name" text PRIMARY KEY NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"case_number" text NOT NULL,
	"client_label" text NOT NULL,
	"title" text NOT NULL,
	"document_type" text DEFAULT 'correspondence' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"encrypted_content" text NOT NULL,
	"content_preview" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"case_number" text NOT NULL,
	"client_label" text NOT NULL,
	"invoice_number" text NOT NULL,
	"subject" text NOT NULL,
	"currency" text DEFAULT 'ZAR' NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"vat_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_invoices_invoice_number_unique" UNIQUE("invoice_number")
);
--> statement-breakpoint
CREATE TABLE "billing_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"case_number" text NOT NULL,
	"entry_type" text NOT NULL,
	"account" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"recipient_role" text DEFAULT 'attorney' NOT NULL,
	"recipient_user_id" uuid,
	"related_entity_type" text,
	"related_entity_id" text,
	"is_read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_type" text DEFAULT 'dashboard' NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_label" text NOT NULL,
	"practice_area" text NOT NULL,
	"jurisdiction" text DEFAULT 'South Africa' NOT NULL,
	"urgency_hint" text DEFAULT 'unspecified' NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"summary_redacted" text NOT NULL,
	"raw_payload_encrypted" text NOT NULL,
	"email_lookup" text NOT NULL,
	"consent_to_ai" boolean DEFAULT false NOT NULL,
	"consent_to_storage" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"role" text DEFAULT 'attorney' NOT NULL,
	"password_hash" text NOT NULL,
	"password_salt" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_intake_submission_id_submissions_id_fk" FOREIGN KEY ("intake_submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_tasks" ADD CONSTRAINT "case_tasks_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_timeline" ADD CONSTRAINT "case_timeline_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_intake_submission_id_submissions_id_fk" FOREIGN KEY ("intake_submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_ledger" ADD CONSTRAINT "billing_ledger_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "calendar_events_starts_at_idx" ON "calendar_events" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "case_tasks_case_id_idx" ON "case_tasks" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "case_timeline_case_id_idx" ON "case_timeline" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "cases_created_at_idx" ON "cases" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "compliance_status_idx" ON "compliance_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "documents_case_id_idx" ON "documents" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "billing_invoices_case_id_idx" ON "billing_invoices" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "billing_ledger_case_id_idx" ON "billing_ledger" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient_role","is_read");--> statement-breakpoint
CREATE INDEX "submissions_created_at_idx" ON "submissions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "submissions_email_lookup_idx" ON "submissions" USING btree ("email_lookup");