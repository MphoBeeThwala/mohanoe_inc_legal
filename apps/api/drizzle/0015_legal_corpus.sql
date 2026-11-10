CREATE TABLE "firm_precedents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"title" text NOT NULL,
	"practice_area" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'review' NOT NULL,
	"original_encrypted" text NOT NULL,
	"review_encrypted" text NOT NULL,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "firm_precedents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "legal_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"title" text NOT NULL,
	"citation" text NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"jurisdiction" text DEFAULT 'South Africa' NOT NULL,
	"version_date" text,
	"authority_level" integer DEFAULT 6 NOT NULL,
	"court" text DEFAULT '' NOT NULL,
	"effective_date" text,
	"validity" text DEFAULT 'in_force' NOT NULL,
	"repealed_date" text,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_passages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"pinpoint" text DEFAULT '' NOT NULL,
	"text" text NOT NULL,
	"repealed" boolean DEFAULT false NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(pinpoint, '') || ' ' || text)) STORED
);
--> statement-breakpoint
CREATE TABLE "legal_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"publisher" text DEFAULT '' NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"licence" text NOT NULL,
	"permission" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_sources_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "precedent_passages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"precedent_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"pinpoint" text DEFAULT '' NOT NULL,
	"text" text NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(pinpoint, '') || ' ' || text)) STORED
);
--> statement-breakpoint
ALTER TABLE "precedent_passages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "research_requests" ADD COLUMN "answer_encrypted" text;--> statement-breakpoint
ALTER TABLE "research_requests" ADD COLUMN "sources_encrypted" text;--> statement-breakpoint
ALTER TABLE "research_requests" ADD COLUMN "answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "research_requests" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "research_requests" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "research_requests" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "research_requests" ADD COLUMN "approval_note_encrypted" text;--> statement-breakpoint
ALTER TABLE "firm_precedents" ADD CONSTRAINT "firm_precedents_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_precedents" ADD CONSTRAINT "firm_precedents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_precedents" ADD CONSTRAINT "firm_precedents_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_source_id_legal_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."legal_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_passages" ADD CONSTRAINT "legal_passages_document_id_legal_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."legal_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "precedent_passages" ADD CONSTRAINT "precedent_passages_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "precedent_passages" ADD CONSTRAINT "precedent_passages_precedent_id_firm_precedents_id_fk" FOREIGN KEY ("precedent_id") REFERENCES "public"."firm_precedents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "firm_precedents_status_idx" ON "firm_precedents" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_documents_source_citation_idx" ON "legal_documents" USING btree ("source_id","citation");--> statement-breakpoint
CREATE INDEX "legal_passages_document_idx" ON "legal_passages" USING btree ("document_id","ordinal");--> statement-breakpoint
CREATE INDEX "legal_passages_search_idx" ON "legal_passages" USING gin ("search");--> statement-breakpoint
CREATE INDEX "precedent_passages_precedent_idx" ON "precedent_passages" USING btree ("precedent_id","ordinal");--> statement-breakpoint
CREATE INDEX "precedent_passages_search_idx" ON "precedent_passages" USING gin ("search");--> statement-breakpoint
ALTER TABLE "research_requests" ADD CONSTRAINT "research_requests_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "firm_precedents_tenant_isolation" ON "firm_precedents" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "precedent_passages_tenant_isolation" ON "precedent_passages" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "firm_precedents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "precedent_passages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "firm_precedents", "precedent_passages" TO app_tenant;
--> statement-breakpoint
GRANT SELECT ON "legal_sources", "legal_documents", "legal_passages" TO app_tenant;
