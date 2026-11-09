-- FICA customer due diligence (roadmap epic 7): per-client risk profile
-- and verification, encrypted KYC documents, and a firm switch that requires
-- verified clients for new matters.
CREATE TABLE "fica_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"file_name_encrypted" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"encrypted_content" text,
	"storage_key" text,
	"content_key_version" integer,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fica_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "fica_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"risk_rating" text DEFAULT 'low' NOT NULL,
	"risk_factors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes_encrypted" text,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"review_due" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fica_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN "fica_enforced" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fica_documents" ADD CONSTRAINT "fica_documents_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fica_documents" ADD CONSTRAINT "fica_documents_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fica_documents" ADD CONSTRAINT "fica_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fica_profiles" ADD CONSTRAINT "fica_profiles_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fica_profiles" ADD CONSTRAINT "fica_profiles_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fica_profiles" ADD CONSTRAINT "fica_profiles_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fica_documents_party_idx" ON "fica_documents" USING btree ("party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fica_profiles_party_idx" ON "fica_profiles" USING btree ("party_id");--> statement-breakpoint
CREATE POLICY "fica_documents_tenant_isolation" ON "fica_documents" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "fica_profiles_tenant_isolation" ON "fica_profiles" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "fica_profiles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fica_documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fica_profiles", "fica_documents" TO app_tenant;
--> statement-breakpoint
GRANT UPDATE ("fica_enforced") ON "firms" TO app_tenant;
