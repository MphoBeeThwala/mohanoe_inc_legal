-- White-label and onboarding (roadmap epic 8): firm profile and onboarding
-- progress, uploaded logo and icon, and custom domains with verification.
CREATE TABLE "firm_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "firm_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "firm_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"domain" text NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'pending_dns' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "firm_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN "profile" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN "onboarding" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "firm_assets" ADD CONSTRAINT "firm_assets_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_domains" ADD CONSTRAINT "firm_domains_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "firm_assets_kind_idx" ON "firm_assets" USING btree ("firm_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "firm_domains_domain_idx" ON "firm_domains" USING btree ("firm_id","domain");--> statement-breakpoint
CREATE INDEX "firm_domains_token_idx" ON "firm_domains" USING btree ("token");--> statement-breakpoint
CREATE POLICY "firm_assets_tenant_isolation" ON "firm_assets" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "firm_domains_tenant_isolation" ON "firm_domains" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "firm_assets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "firm_domains" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "firm_assets", "firm_domains" TO app_tenant;
--> statement-breakpoint
GRANT UPDATE ("legal_name", "trading_name", "branding", "case_prefix", "domains", "profile", "onboarding") ON "firms" TO app_tenant;
