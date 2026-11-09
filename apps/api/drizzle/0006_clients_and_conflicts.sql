-- Clients, parties and conflict checks (roadmap epic 7).
-- parties: encrypted register of clients and other parties; party_index:
-- blind-index hashes for search and conflict checks; conflict_checks: the
-- firm's record of every check and its decision; case_parties: who is on a
-- matter (matter-scoped). Matters can now be opened for a client without an
-- intake (cases.intake_submission_id becomes optional) and get a title.
CREATE TABLE "case_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "case_parties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conflict_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"query_encrypted" text NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"strong_matches" integer DEFAULT 0 NOT NULL,
	"possible_matches" integer DEFAULT 0 NOT NULL,
	"decision" text DEFAULT 'pending' NOT NULL,
	"decision_notes_encrypted" text,
	"performed_by" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conflict_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"party_number" text NOT NULL,
	"kind" text NOT NULL,
	"is_client" boolean DEFAULT false NOT NULL,
	"client_since" timestamp with time zone,
	"details_encrypted" text NOT NULL,
	"conflict_check_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "parties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party_index" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"field" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "party_index" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cases" ALTER COLUMN "intake_submission_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "case_parties" ADD CONSTRAINT "case_parties_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_parties" ADD CONSTRAINT "case_parties_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_parties" ADD CONSTRAINT "case_parties_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_checks" ADD CONSTRAINT "conflict_checks_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_checks" ADD CONSTRAINT "conflict_checks_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_checks" ADD CONSTRAINT "conflict_checks_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_index" ADD CONSTRAINT "party_index_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_index" ADD CONSTRAINT "party_index_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "case_parties_unique_idx" ON "case_parties" USING btree ("case_id","party_id","role");--> statement-breakpoint
CREATE INDEX "case_parties_party_idx" ON "case_parties" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "conflict_checks_created_idx" ON "conflict_checks" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "parties_firm_number_idx" ON "parties" USING btree ("firm_id","party_number");--> statement-breakpoint
CREATE INDEX "parties_is_client_idx" ON "parties" USING btree ("is_client");--> statement-breakpoint
CREATE INDEX "party_index_hash_idx" ON "party_index" USING btree ("firm_id","hash");--> statement-breakpoint
CREATE INDEX "party_index_party_idx" ON "party_index" USING btree ("party_id");--> statement-breakpoint
CREATE POLICY "case_parties_tenant_isolation" ON "case_parties" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "case_parties_matter_access" ON "case_parties" AS RESTRICTIVE FOR ALL TO "app_tenant" USING (exists (select 1 from cases c where c.id = case_parties.case_id)) WITH CHECK (exists (select 1 from cases c where c.id = case_parties.case_id));--> statement-breakpoint
CREATE POLICY "conflict_checks_tenant_isolation" ON "conflict_checks" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "parties_tenant_isolation" ON "parties" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_index_tenant_isolation" ON "party_index" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "parties" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "party_index" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "conflict_checks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "case_parties" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "parties", "party_index", "conflict_checks", "case_parties" TO app_tenant;
