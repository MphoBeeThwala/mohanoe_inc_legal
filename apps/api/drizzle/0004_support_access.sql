-- Platform support access (roadmap 5.3).
-- platform_operators: Ahava on 88 support staff. Platform-level table; the
-- app_tenant role is given no access to it.
-- support_grants: a firm administrator's time-boxed approval for support to
-- sign in to that firm (read-only). users.platform_operator_id marks the
-- firm's stand-in account for an operator.
CREATE TABLE "platform_operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"password_salt" text NOT NULL,
	"mfa_secret_encrypted" text NOT NULL,
	"mfa_last_step" bigint,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_operators_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "support_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"reason" text NOT NULL,
	"granted_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "platform_operator_id" uuid;--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_grants_expires_idx" ON "support_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE POLICY "support_grants_tenant_isolation" ON "support_grants" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "support_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "support_grants" TO app_tenant;
--> statement-breakpoint
REVOKE ALL ON "platform_operators" FROM app_tenant;
