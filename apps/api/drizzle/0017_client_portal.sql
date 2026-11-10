CREATE TABLE "portal_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"portal_user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "portal_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"sender" text NOT NULL,
	"portal_user_id" uuid,
	"staff_user_id" uuid,
	"body_encrypted" text NOT NULL,
	"read_by_client_at" timestamp with time zone,
	"read_by_staff_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "portal_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"portal_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "portal_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"email_index" text NOT NULL,
	"email_encrypted" text NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"totp_secret_encrypted" text,
	"last_totp_step" integer,
	"invited_by" uuid,
	"last_sign_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "client_update_encrypted" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "client_update_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "shared_with_client_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "portal_links" ADD CONSTRAINT "portal_links_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_links" ADD CONSTRAINT "portal_links_portal_user_id_portal_users_id_fk" FOREIGN KEY ("portal_user_id") REFERENCES "public"."portal_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_messages" ADD CONSTRAINT "portal_messages_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_messages" ADD CONSTRAINT "portal_messages_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_messages" ADD CONSTRAINT "portal_messages_portal_user_id_portal_users_id_fk" FOREIGN KEY ("portal_user_id") REFERENCES "public"."portal_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_messages" ADD CONSTRAINT "portal_messages_staff_user_id_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_sessions" ADD CONSTRAINT "portal_sessions_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_sessions" ADD CONSTRAINT "portal_sessions_portal_user_id_portal_users_id_fk" FOREIGN KEY ("portal_user_id") REFERENCES "public"."portal_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_users" ADD CONSTRAINT "portal_users_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_users" ADD CONSTRAINT "portal_users_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_users" ADD CONSTRAINT "portal_users_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_links_token_idx" ON "portal_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "portal_messages_case_idx" ON "portal_messages" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_sessions_token_idx" ON "portal_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_users_party_idx" ON "portal_users" USING btree ("firm_id","party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_users_email_idx" ON "portal_users" USING btree ("firm_id","email_index");--> statement-breakpoint
CREATE POLICY "portal_links_tenant_isolation" ON "portal_links" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "portal_messages_tenant_isolation" ON "portal_messages" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "portal_messages_matter_access" ON "portal_messages" AS RESTRICTIVE FOR ALL TO "app_tenant" USING (exists (select 1 from cases c where c.id = portal_messages.case_id)) WITH CHECK (exists (select 1 from cases c where c.id = portal_messages.case_id));--> statement-breakpoint
CREATE POLICY "portal_sessions_tenant_isolation" ON "portal_sessions" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "portal_users_tenant_isolation" ON "portal_users" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "portal_users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "portal_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "portal_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "portal_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "portal_users", "portal_links", "portal_sessions" TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "portal_messages" TO app_tenant;
