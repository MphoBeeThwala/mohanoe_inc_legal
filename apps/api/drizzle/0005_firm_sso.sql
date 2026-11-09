-- Per-firm Microsoft 365 (Entra ID) staff sign-in settings, which a firm's
-- administrators manage (app_tenant may update only its own firm's row).
ALTER TABLE "firms" ADD COLUMN "sso_tenant_id" text;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN "sso_domains" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN "sso_enforced" boolean DEFAULT false NOT NULL;--> statement-breakpoint
GRANT UPDATE ("sso_tenant_id", "sso_domains", "sso_enforced") ON "firms" TO app_tenant;
